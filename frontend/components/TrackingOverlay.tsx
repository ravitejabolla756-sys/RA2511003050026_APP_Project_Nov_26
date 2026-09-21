"use client";

import { RefObject, useEffect, useRef } from "react";

export type TrackedDetection = {
  box: [number, number, number, number];
  class: string;
  class_id: number;
  id: number | null;
  confidence: number;
};

export type OverlayAnalysis = {
  status: string;
  epoch?: number;
  source_timestamp?: number | null;
  detection_age_ms?: number | null;
  detections?: TrackedDetection[];
};

export type OverlaySync = { aligned: boolean; skewMs: number | null };

type TrackingOverlayProps = {
  videoRef: RefObject<HTMLVideoElement>;
  analysis: OverlayAnalysis | null;
  alignment: "live" | "media-time";
  onSync?: (sync: OverlaySync) => void;
  showAnnotations: boolean;
  showTrackIds: boolean;
};

const MAX_SOURCE_TIME_SKEW_SECONDS = 2.5;

export function TrackingOverlay({ videoRef, analysis, alignment, onSync, showAnnotations, showTrackIds }: TrackingOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analysisRef = useRef(analysis);
  const onSyncRef = useRef(onSync);

  useEffect(() => {
    analysisRef.current = analysis;
  }, [analysis]);
  useEffect(() => {
    onSyncRef.current = onSync;
  }, [onSync]);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!video || !canvas || !context) return;

    let frameRequest = 0;
    let alignedEpoch: number | undefined;
    let sourceTimeOffset: number | null = null;
    let lastSyncReport = 0;

    const draw = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        context.clearRect(0, 0, canvas.width, canvas.height);

        const current = analysisRef.current;
        const sourceTimestamp = current?.source_timestamp;
        const ageSeconds = alignment === "live" ? Math.max(0, current?.detection_age_ms ?? 0) / 1000 : 0;
        const shouldReportSync = performance.now() - lastSyncReport >= 1000;

        if (current?.epoch !== alignedEpoch) {
          alignedEpoch = current?.epoch;
          sourceTimeOffset = null;
        }

        if (sourceTimestamp != null && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
          && (sourceTimeOffset == null || (alignment === "live" && shouldReportSync))) {
          const observedOffset = sourceTimestamp + ageSeconds - video.currentTime;
          sourceTimeOffset = sourceTimeOffset == null ? observedOffset : sourceTimeOffset * 0.5 + observedOffset * 0.5;
        }

        const videoSourceTime = alignment === "media-time"
          ? video.currentTime
          : sourceTimeOffset == null ? null : video.currentTime + sourceTimeOffset;
        const analyzedSourceTime = sourceTimestamp == null
          ? null
          : sourceTimestamp + (alignment === "live" ? ageSeconds : 0);
        const skew = videoSourceTime != null && analyzedSourceTime != null
          ? Math.abs(videoSourceTime - analyzedSourceTime)
          : null;
        const sourceIsAligned = skew != null && skew <= MAX_SOURCE_TIME_SKEW_SECONDS;

        if (shouldReportSync) {
          lastSyncReport = performance.now();
          onSyncRef.current?.({ aligned: sourceIsAligned, skewMs: skew == null ? null : Math.round(skew * 1000) });
        }

        if (showAnnotations && current?.status === "TRACKING" && sourceIsAligned) {
          const lineWidth = Math.max(0.75, canvas.width / 1400);
          const fontSize = Math.max(9, Math.min(12, canvas.width * 0.013));
          context.lineWidth = lineWidth;
          context.font = `600 ${fontSize}px sans-serif`;
          for (const detection of current.detections ?? []) {
            const [x1, y1, x2, y2] = detection.box;
            const color = detection.class_id === 0 ? "#35e39a" : detection.class_id === 2 ? "#b98cff" : "#f6c453";
            const label = `${detection.class.toUpperCase()}${showTrackIds && detection.id != null ? ` ID ${detection.id}` : ""} ${Math.round(detection.confidence * 100)}%`;
            const labelWidth = context.measureText(label).width;
            const labelTop = Math.max(fontSize + 4, y1);

            context.strokeStyle = color;
            context.strokeRect(x1, y1, x2 - x1, y2 - y1);
            context.fillStyle = color;
            context.fillRect(x1, labelTop - fontSize - 3, labelWidth + 6, fontSize + 3);
            context.fillStyle = "#07120d";
            context.fillText(label, x1 + 3, labelTop - 3);
          }
        }
      }

      frameRequest = window.requestAnimationFrame(draw);
    };

    frameRequest = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frameRequest);
  }, [videoRef, alignment, showAnnotations, showTrackIds]);

  return <canvas ref={canvasRef} className="trackingOverlayCanvas" aria-hidden="true" />;
}
