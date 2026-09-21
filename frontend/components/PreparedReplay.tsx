"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type TrackedObject = { id: number; box: number[]; class_id: number; confidence: number };
type Sample = { frame: number; source_timestamp?: number; objects: TrackedObject[] };
type Tracks = { fps: number; width: number; height: number; step: number; frames: Sample[]; model: string; tracker?: string; mode?: string };
export type ReplaySource = { name: string; title: string; source_url: string; tracks_url?: string };
const classes: Record<number,string> = {0:"Person",2:"Car",3:"Motorcycle",5:"Bus",7:"Truck"};
const trackingColors = { person: "#35e39a", car: "#b98cff", vehicle: "#f6c453" };

function TrackingLegend({ tracking }: { tracking: boolean }) {
  return <div className="trackingLegend" aria-label="Tracking color legend">
    <span><i style={{ backgroundColor: trackingColors.person }} /> People</span>
    <span><i style={{ backgroundColor: trackingColors.car }} /> Cars</span>
    <span><i style={{ backgroundColor: trackingColors.vehicle }} /> Other vehicles</span>
    <em>{tracking ? "Tracking active" : "Tracking unavailable for this video"}</em>
  </div>;
}

export function PreparedReplay({ source }: { source: ReplaySource }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tracks, setTracks] = useState<Tracks | null>(null);
  const [message, setMessage] = useState("Preparing analysis; original video plays at normal speed.");
  const [annotations, setAnnotations] = useState(true);
  const [ids, setIds] = useState(true);
  const [counts, setCounts] = useState({people:0,vehicles:0});

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(source.tracks_url ?? `${source.source_url}/tracks`, {signal:controller.signal,cache:"no-store"});
        if (!response.ok) throw new Error(response.status === 409 ? "Analysis is being prepared. Video plays at normal speed." : "Analysis unavailable; retrying.");
        const data: Tracks = await response.json();
        const ordered = data.frames.every((sample, index) => {
          const previous = data.frames[index - 1];
          return index === 0 || (previous !== undefined && sample.frame > previous.frame &&
            (sample.source_timestamp == null || previous.source_timestamp == null ||
             sample.source_timestamp > previous.source_timestamp));
        });
        if (!ordered) throw new Error("Analysis rejected: source frame order is invalid.");
        if (!cancelled) { setTracks(data); setMessage(`${data.model} + ${data.tracker ?? "timestamp-aware tracker"} · prepared replay · 1× source playback`); }
      } catch (error) {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : "Analysis unavailable");
          timer = setTimeout(load,5000);
        }
      }
    }
    void load();
    return () => {cancelled=true;clearTimeout(timer);controller.abort();};
  },[source.source_url, source.tracks_url]);

  const clipTracks = useMemo(() => {
    if (!tracks) return { people: 0, vehicles: 0 };
    const people = new Set<number>();
    const vehicles = new Set<number>();
    for (const sample of tracks.frames) for (const object of sample.objects) {
      (object.class_id === 0 ? people : vehicles).add(object.id);
    }
    return { people: people.size, vehicles: vehicles.size };
  }, [tracks]);

  useEffect(() => {
    const player = video.current;
    const overlay = canvas.current;
    if (!player || !overlay || !tracks) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    let callback = 0;
    let stopped = false;
    let lastSample = -1;
    let canvasCleared = false;
    let scaleX = 1;
    let scaleY = 1;
    let cssScale = 1;
    const resize = () => {
      const bounds = overlay.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const pixelRatio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(bounds.width * pixelRatio));
      const height = Math.max(1, Math.round(bounds.height * pixelRatio));
      if (overlay.width !== width) overlay.width = width;
      if (overlay.height !== height) overlay.height = height;
      scaleX = width / tracks.width;
      scaleY = height / tracks.height;
      cssScale = tracks.width / bounds.width;
      ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(overlay);
    function draw(time: number) {
      if (!ctx || !overlay || !tracks) return;
      // When annotations are disabled, do not spend a video-frame callback
      // redrawing an empty canvas. The video remains completely independent
      // from the analysis layer and keeps its native playback cadence.
      if (!annotations) {
        if (!canvasCleared) {
          ctx.clearRect(0, 0, tracks.width, tracks.height);
          canvasCleared = true;
        }
      } else {
        canvasCleared = false;
        ctx.clearRect(0, 0, tracks.width, tracks.height);
      }
      const frame = time * tracks.fps;
      // Binary search also handles seek, pause and looping.
      let low=0, high=tracks.frames.length-1;
      while (low<high) {const mid=Math.ceil((low+high)/2);if(tracks.frames[mid].frame<=frame)low=mid;else high=mid-1;}
      const a=tracks.frames[low], b=tracks.frames[Math.min(low+1,tracks.frames.length-1)];
      if (!a) return;
      const aTime = a.source_timestamp ?? a.frame / tracks.fps;
      const bTime = b.source_timestamp ?? b.frame / tracks.fps;
      // Never keep an older analysis attached after playback has passed its
      // source-time interval. This prevents frame N from carrying state from
      // an unrelated earlier sample when cache/video timelines diverge.
      if (time < aTime || (low < tracks.frames.length - 1 && time > bTime)) {
        if (low!==lastSample) { lastSample=low; setCounts({people:0,vehicles:0}); }
        return;
      }
      if (low!==lastSample) {
        lastSample=low;
        setCounts({people:a.objects.filter(o=>o.class_id===0).length,vehicles:a.objects.filter(o=>o.class_id!==0).length});
      }
      if (!annotations) return;
      // Track coordinates are in source-video pixels. Scale annotation
      // strokes and labels inversely to the rendered video size so they stay
      // legible in both the compact viewer tile and fullscreen layouts.
      // cssScale converts source pixels to CSS pixels. Keep the visual weight
      // stable instead of multiplying by the scale twice.
      const lineWidth = 1 * cssScale;
      const fontSize = 7 * cssScale;
      const labelHeight = 10 * cssScale;
      const drawObject = (item: TrackedObject, box: number[]) => {
        const color = item.class_id === 0 ? trackingColors.person : item.class_id === 2 ? trackingColors.car : trackingColors.vehicle;
        const [left, top, right, bottom] = box;
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.strokeRect(left, top, right - left, bottom - top);
        const label = ids && item.id != null ? `#${item.id}` : classes[item.class_id] || "Object";
        ctx.font = `600 ${fontSize}px sans-serif`;
        const labelWidth = ctx.measureText(label).width + 4 * cssScale;
        const labelTop = Math.max(0, top - labelHeight);
        ctx.fillStyle = color;
        ctx.fillRect(left, labelTop, labelWidth, labelHeight);
        ctx.fillStyle = "#06110d";
        ctx.textBaseline = "middle";
        ctx.fillText(label, left + 2 * cssScale, labelTop + labelHeight / 2);
      };
      const ratio=b.frame>a.frame?Math.min(1,Math.max(0,(frame-a.frame)/(b.frame-a.frame))):0;
      const next=new Map(b.objects.map(o=>[o.id,o]));
      for(const item of a.objects) {
        const end=next.get(item.id);
        // Keep an object visible through a short detector gap, but do not
        // invent boxes for the entire interval when a track really ended.
        if (!end && ratio > 0.45) continue;
        const box=item.box.map((v,i)=>end?v+(end.box[i]-v)*ratio:v);
        drawObject(item, box);
      }
      // Render newly entered tracks during the latter half of a sample gap.
      if (ratio > 0.55) for (const item of b.objects) {
        if (a.objects.some(existing => existing.id === item.id)) continue;
        drawObject(item, item.box);
      }
    }
    function tick(_now:number, metadata:VideoFrameCallbackMetadata) {
      if(stopped || !player)return;
      draw(metadata.mediaTime);
      callback=player.requestVideoFrameCallback(tick);
    }
    const redraw=()=>draw(player.currentTime);
    callback=player.requestVideoFrameCallback(tick);
    player.addEventListener("seeked",redraw);
    redraw();
    return ()=>{stopped=true;player.cancelVideoFrameCallback(callback);player.removeEventListener("seeked",redraw);resizeObserver.disconnect();};
  },[tracks,annotations,ids]);

  return <article className="viewerTile"><div className="streamFrame">
    <div style={{position:"relative",lineHeight:0}}>
      <video ref={video} src={source.source_url} controls autoPlay muted loop playsInline preload="auto"
        style={{width:"100%",height:"auto",minHeight:0,display:"block",objectFit:"contain"}}
        onCanPlay={(event)=>{ void event.currentTarget.play().catch(()=>undefined); }}
        onEnded={(event)=>{ event.currentTarget.currentTime = 0; void event.currentTarget.play().catch(()=>undefined); }}
        onError={()=>setMessage("Video could not load. Check that the local backend is running.")}/>
      <canvas ref={canvas} style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none"}}/>
    </div>
    <TrackingLegend tracking={Boolean(tracks)} />
    <div className="viewerControls">
      <label><input type="checkbox" checked={annotations} onChange={e=>setAnnotations(e.target.checked)}/> Show AI annotations</label>
      <label><input type="checkbox" checked={ids} onChange={e=>setIds(e.target.checked)}/> Track IDs</label>
    </div>
    <small role="status">{message}</small>
    {tracks?<div className="analyticsOverlay"><b>VISIBLE NOW</b><span>People {counts.people}</span><span>Vehicles {counts.vehicles}</span><b>TRACK IDS IN THIS CLIP · ESTIMATE</b><span>People {clipTracks.people}</span><span>Vehicles {clipTracks.vehicles}</span><em>{tracks.mode ?? `Source timestamps at ${tracks.fps/tracks.step} analysed FPS.`}</em></div>:null}
    </div><footer><strong>{source.title}</strong><span className="statusTag">LOOPING DEMO</span></footer></article>;
}
