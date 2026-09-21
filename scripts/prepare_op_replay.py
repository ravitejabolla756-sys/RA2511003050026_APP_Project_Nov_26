"""Prepare frame-indexed person/vehicle tracks for local demo videos."""
import argparse
import json
import os
from pathlib import Path
import sys
import time

import cv2
import torch

try:
    _TORCHVISION_LIBRARY = torch.library.Library("torchvision", "DEF")
    _TORCHVISION_LIBRARY.define("nms(Tensor dets, Tensor scores, float iou_threshold) -> Tensor")
except Exception:
    _TORCHVISION_LIBRARY = None

from ultralytics import YOLO
from ultralytics.engine.results import Boxes
from ultralytics.utils.nms import TorchNMS

try:
    import torchvision
    torchvision.ops.nms = TorchNMS.nms
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ('anpr-vms-a.mp4', 'anpr-vms-b.mp4', 'OP.mp4', 'vms-a.mp4', 'vms-b.mp4')
sys.path.insert(0, str(ROOT / 'backend'))
from app.services.timestamp_tracker import TimestampAwareTracker, TrackerConfig


def batched_nms(boxes, scores, classes, threshold):
    """Portable class-aware NMS without depending on torchvision's native op."""
    keep = []
    for class_id in torch.unique(classes).tolist():
        indices = [int(index) for index in torch.where(classes == class_id)[0].tolist()]
        indices.sort(key=lambda index: float(scores[index]), reverse=True)
        while indices:
            current = indices.pop(0)
            keep.append(current)
            remaining = []
            for index in indices:
                first, second = boxes[current], boxes[index]
                x1, y1 = max(float(first[0]), float(second[0])), max(float(first[1]), float(second[1]))
                x2, y2 = min(float(first[2]), float(second[2])), min(float(first[3]), float(second[3]))
                intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
                area_first = max(0.0, float(first[2] - first[0])) * max(0.0, float(first[3] - first[1]))
                area_second = max(0.0, float(second[2] - second[0])) * max(0.0, float(second[3] - second[1]))
                overlap = intersection / max(area_first + area_second - intersection, 1e-6)
                if overlap < threshold:
                    remaining.append(index)
            indices = remaining
    return torch.tensor(keep, dtype=torch.long)


def cache_is_current(cache: Path, source: Path, step: int, model_name: str) -> bool:
    if not cache.is_file():
        return False
    try:
        payload = json.loads(cache.read_text(encoding='utf-8'))
        stat = source.stat()
        return (payload.get('source_size') == stat.st_size and
                payload.get('source_mtime_ns') == stat.st_mtime_ns and
            payload.get('step') == step and payload.get('model') == model_name)
    except (OSError, ValueError, TypeError):
        return False


def prepare_source(name: str, model, step: int, model_name: str) -> None:
    source = ROOT / 'demo-media' / name
    output = ROOT / '.runtime' / 'demo-replays' / Path(name).stem
    cache = output / 'tracks.json'
    output.mkdir(parents=True, exist_ok=True)
    progress_file = output / 'progress.json'
    if cache_is_current(cache, source, step, model_name):
        payload = json.loads(cache.read_text(encoding='utf-8'))
        progress_file.write_text(json.dumps({'status': 'ready', 'frame': payload['total_frames'],
                                             'total': payload['total_frames'], 'percent': 100.0,
                                             'samples': len(payload['frames'])}), encoding='utf-8')
        print({'source': name, 'status': 'current cache'}, flush=True)
        return
    # Reuse the already-prepared OP cache when it exactly matches this source
    # and sample interval; no expensive reanalysis is needed after migration.
    legacy = ROOT / '.runtime' / 'op-replay' / 'tracks.json'
    if name == 'OP.mp4' and cache_is_current(legacy, source, step, model_name):
        payload = json.loads(legacy.read_text(encoding='utf-8'))
        payload['source'] = name
        payload['mode'] = f"Prepared replay; source timestamps; timestamp-aware tracking at {payload['fps']/step:.2f} analysis FPS"
        temporary = output / 'tracks.tmp.json'
        temporary.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
        os.replace(temporary, cache)
        progress_file.write_text(json.dumps({'status': 'ready', 'frame': payload['total_frames'],
                                             'total': payload['total_frames'], 'percent': 100.0,
                                             'samples': len(payload['frames'])}), encoding='utf-8')
        print({'source': name, 'status': 'migrated existing cache'}, flush=True)
        return
    tracker = TimestampAwareTracker(TrackerConfig(high_confidence=.35, low_confidence=.15,
                                                   new_track_confidence=.45,
                                                   max_lost_seconds=1.5))
    cap = cv2.VideoCapture(str(source))
    if not cap.isOpened():
        raise RuntimeError(f'Cannot open {name}')
    fps = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frames = []
    started = time.monotonic()
    try:
        index = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if index % step == 0 or index == total - 1:
                height, width = frame.shape[:2]
                # Full view plus a magnified left road / station entrance pass.
                merged = []
                for crop, size in ((frame,1280),(frame[:, :round(width*.62)],960)):
                    result = model.predict(crop, imgsz=size, conf=.18,
                                           classes=[0,2,3,5,7], verbose=False)[0]
                    merged.append(result.boxes.data.cpu())
                data = torch.cat(merged)
                keep = batched_nms(data[:,:4],data[:,4],data[:,5],.45)
                boxes = Boxes(data[keep],(height,width)).numpy()
                candidates = [{'box': [float(value) for value in box],
                               'class_id': int(cls), 'confidence': float(confidence)}
                              for box, cls, confidence in zip(boxes.xyxy, boxes.cls, boxes.conf)]
                tracked = tracker.update(candidates, index / fps)
                objects = [{'id': int(item['id']), 'box': [round(float(v), 2) for v in item['box']],
                            'confidence': round(float(item['confidence']), 3),
                            'class_id': int(item['class_id'])}
                           for item in tracked['detections'] if item['id'] is not None]
                frames.append({'frame': index, 'source_timestamp': round(index / fps, 6), 'objects': objects,
                               'telemetry': tracked['telemetry']})
                if len(frames) % 30 == 0:
                    progress = {'status':'processing','frame':index,'total':total,
                                'percent':round(100*index/total,1)}
                    (output/'progress.json').write_text(json.dumps(progress))
                    print({'source': name, **progress,
                           'elapsed': round(time.monotonic()-started)}, flush=True)
            index += 1
    finally:
        cap.release()
    if index != total:
        raise RuntimeError(f'Incomplete decode for {name}: {index}/{total}')
    stat = source.stat()
    payload = {'version':1,'source':name,'source_size':stat.st_size,
               'source_mtime_ns':stat.st_mtime_ns,
               'model':model_name,'tracker':'BoT-SORT','fps':fps,'width':width,'height':height,
               'total_frames':total,'step':step,'frames':frames,
               'mode':f'Prepared replay; source timestamps; timestamp-aware tracking at {fps/step:.2f} analysis FPS'}
    temp = output/'tracks.tmp.json'
    temp.write_text(json.dumps(payload,separators=(',',':')),encoding='utf-8')
    os.replace(temp,output/'tracks.json')
    progress_file.write_text(json.dumps({'status': 'ready', 'frame': total,
                                         'total': total, 'percent': 100.0,
                                         'samples': len(frames)}), encoding='utf-8')
    print({'source':name,'status':'ready','samples':len(frames),
           'analysis_fps':round(fps/step,2),
           'seconds':round(time.monotonic()-started)},flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--all', action='store_true', help='prepare every allowlisted demo video')
    parser.add_argument('--source', choices=SOURCES, action='append',
                        help='prepare one source (repeatable); defaults to OP.mp4')
    parser.add_argument('--model', default=os.environ.get('SURAKSH_REPLAY_MODEL', 'yolo26s.pt'),
                        help='local YOLO weights; stronger models improve recall but require more CPU time')
    args = parser.parse_args()
    names = SOURCES if args.all else tuple(args.source or ('OP.mp4',))
    step = max(1, int(os.environ.get('SURAKSH_DEMO_REPLAY_STEP',
                                    os.environ.get('SURAKSH_OP_REPLAY_STEP', '10'))))
    torch.set_num_threads(2)
    cv2.setNumThreads(1)
    model_path = Path(args.model)
    if not model_path.is_absolute():
        model_path = ROOT / model_path
    model = YOLO(str(model_path))
    model_name = model_path.stem.upper()
    for name in names:
        prepare_source(name, model, step, model_name)


if __name__ == '__main__':
    main()
