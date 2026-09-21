"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { API_URL, apiRequest } from "@/lib/api";
import { OverlayAnalysis, OverlaySync, TrackingOverlay } from "./TrackingOverlay";

type PublicCameraRuntime = OverlayAnalysis & {
  frame: number;
  detection_frame: number | null;
  people: number | null;
  vehicles: number | null;
  cars: number | null;
  motorcycles: number | null;
  buses: number | null;
  trucks: number | null;
  source_width?: number;
  source_height?: number;
  ai_frames: number;
  ai_fps: number;
  inference_ms: number | null;
  model: string;
  device: string;
  unique_people?: number;
  unique_car?: number;
  unique_motorcycle?: number;
  unique_bus?: number;
  unique_truck?: number;
  ai_error?: string | null;
};

type VideoStatus = "connecting" | "live" | "offline" | "unsupported";
type TrackingStatus = "connecting" | "tracking" | "stale" | "source-unavailable" | "ai-error" | "disconnected";

const STREAM_URL = "/api/public-live-camera/playlist.m3u8";

function trackingStatus(runtime: PublicCameraRuntime | null, disconnected: boolean): TrackingStatus {
  if (disconnected) return "disconnected";
  switch (runtime?.status) {
    case "TRACKING": return "tracking";
    case "AI_ERROR": return "ai-error";
    case "SOURCE_UNAVAILABLE":
    case "SOURCE_RECONNECTING":
    case "DECODE_ERROR": return "source-unavailable";
    case "STALE": return "stale";
    default: return "connecting";
  }
}

function trackingStatusLabel(status: TrackingStatus) {
  return {
    connecting: "AI STARTING",
    tracking: "TRACKING",
    stale: "WAITING FOR ANALYSIS",
    "source-unavailable": "AI SOURCE UNAVAILABLE",
    "ai-error": "AI PROCESSING ERROR",
    disconnected: "TRACKER API UNAVAILABLE",
  }[status];
}

function statusMessage(status: TrackingStatus, error?: string | null) {
  if (status === "ai-error") return `Video is playing, but AI processing failed${error ? ` (${error})` : "."}`;
  if (status === "source-unavailable") return "The DOT source used by the tracker is unavailable; it will retry automatically.";
  if (status === "disconnected") return "Could not reach SURAKSH’s tracker. Check that the backend is running.";
  if (status === "stale") return "Video continues at source speed; waiting for a fresh AI observation.";
  return "The live video plays independently while the tracker starts.";
}

export function PublicLiveCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoStatus, setVideoStatus] = useState<VideoStatus>("connecting");
  const [runtime, setRuntime] = useState<PublicCameraRuntime | null>(null);
  const [overlaySync, setOverlaySync] = useState<OverlaySync | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [showTrackIds, setShowTrackIds] = useState(true);
  const [retry, setRetry] = useState(0);

  const status = trackingStatus(runtime, disconnected);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let active = true;
    let hls: Hls | undefined;
    setVideoStatus("connecting");
    video.src = "";
    video.load();

    const markOffline = () => {
      if (active) setVideoStatus("offline");
    };
    video.addEventListener("error", markOffline);

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = STREAM_URL;
      void video.play().catch(() => undefined);
    } else if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        liveSyncDurationCount: 2,
        maxBufferLength: 12,
        backBufferLength: 20,
      });
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls?.loadSource(STREAM_URL));
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        void video.play().catch(() => undefined);
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) markOffline();
      });
      hls.attachMedia(video);
    } else {
      setVideoStatus("unsupported");
    }

    return () => {
      active = false;
      video.removeEventListener("error", markOffline);
      hls?.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [retry]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const poll = async () => {
      controller = new AbortController();
      try {
        const value = await apiRequest<PublicCameraRuntime>("/public-live-camera/runtime", undefined, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (active) {
          setRuntime(value);
          setDisconnected(false);
        }
      } catch {
        if (active) setDisconnected(true);
      } finally {
        if (active) timer = window.setTimeout(poll, 1000);
      }
    };

    setDisconnected(false);
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [retry]);

  const confirmedTracks = (runtime?.unique_people ?? 0)
    + (runtime?.unique_car ?? 0)
    + (runtime?.unique_motorcycle ?? 0)
    + (runtime?.unique_bus ?? 0)
    + (runtime?.unique_truck ?? 0);
  const currentObjects = (runtime?.people ?? 0) + (runtime?.vehicles ?? 0);

  return <section className="publicCameraSection" aria-labelledby="public-camera-heading">
    <header className="publicCameraHeader">
      <div>
        <p className="eyebrow">PUBLIC LIVE CAMERA · IOWA, USA</p>
        <h2 id="public-camera-heading">I-680 · Council Bluffs</h2>
        <p>Official Iowa DOT live traffic source. The original video plays normally; SURAKSH analyzes it separately and overlays only fresh detections.</p>
      </div>
      <div className="publicCameraStatuses">
        <span className={`liveStreamStatus ${videoStatus}`} role="status" aria-live="polite">
          <i aria-hidden="true" />{videoStatus === "live" ? "VIDEO LIVE" : videoStatus === "connecting" ? "CONNECTING" : videoStatus === "offline" ? "VIDEO UNAVAILABLE" : "PLAYBACK UNSUPPORTED"}
        </span>
        <span className={`liveStreamStatus ${status}`} role="status" aria-live="polite">
          <i aria-hidden="true" />{status === "tracking" && currentObjects === 0 ? "NO CURRENT TRACKS" : trackingStatusLabel(status)}
        </span>
      </div>
    </header>

    <div className="publicLivePlayer">
      <video
        ref={videoRef}
        controls
        muted
        autoPlay
        playsInline
        preload="none"
        onPlaying={() => setVideoStatus("live")}
        aria-label="Original live Iowa DOT traffic video at I-680 near 130th Street"
      />
      <TrackingOverlay key={retry} videoRef={videoRef} analysis={runtime} alignment="live" onSync={setOverlaySync} showAnnotations={showAnnotations} showTrackIds={showTrackIds} />
      {videoStatus !== "live" && <div className="publicLiveOverlay" role="status">
        <strong>{videoStatus === "connecting" ? "Connecting to Iowa DOT’s live video…" : videoStatus === "offline" ? "The public camera video is temporarily unavailable." : "This browser cannot play the public live video."}</strong>
      </div>}
    </div>

    <div className="publicLiveControls">
      <label><input type="checkbox" checked={showAnnotations} onChange={(event) => setShowAnnotations(event.target.checked)} /> Show AI boxes</label>
      <label><input type="checkbox" checked={showTrackIds} onChange={(event) => setShowTrackIds(event.target.checked)} /> Show track IDs</label>
      <button type="button" className="secondaryButton" onClick={() => setRetry((value) => value + 1)}>Retry video and tracking</button>
      <small>{runtime?.source_width && runtime?.source_height ? `DOT source ${runtime.source_width}×${runtime.source_height}` : "DOT source resolution unavailable"} · AI sampled at {runtime?.ai_fps ?? 0} FPS on {runtime?.device ?? "CPU"} · {overlaySync?.aligned ? "overlay time-aligned" : overlaySync?.skewMs != null ? `overlay waiting for sync (${(overlaySync.skewMs / 1000).toFixed(1)}s)` : "checking overlay sync"}</small>
    </div>

    <section className="publicCameraMetrics" aria-label="Live camera tracking results" aria-live="polite">
      <b>{status === "tracking" ? `LATEST AI RESULT · FRAME ${runtime?.detection_frame ?? "—"}` : "LATEST AI RESULT · WAITING FOR FRESH ANALYSIS"}</b>
      <span>People {status === "tracking" ? runtime?.people ?? 0 : "—"}</span>
      <span>Vehicles {status === "tracking" ? runtime?.vehicles ?? 0 : "—"}</span>
      <span>{status === "tracking" ? runtime?.cars ?? 0 : "—"} cars · {status === "tracking" ? runtime?.motorcycles ?? 0 : "—"} motorcycles · {status === "tracking" ? runtime?.buses ?? 0 : "—"} buses · {status === "tracking" ? runtime?.trucks ?? 0 : "—"} trucks</span>
      <span>Confirmed anonymous tracks this session {status === "tracking" ? confirmedTracks : "—"}</span>
      <small>{runtime?.model ?? "YOLO"} · {runtime?.inference_ms ?? "—"} ms latest inference</small>
      {status === "tracking" && currentObjects === 0 && <em>No people or vehicles detected in the latest frame; tracking is active but this low-resolution view has no current tracks.</em>}
      {status !== "tracking" && <em>{statusMessage(status, runtime?.ai_error)}</em>}
    </section>

    <footer className="publicLiveFooter">
      <span>Public Iowa DOT video · SURAKSH does not record or store this feed. The source is low-resolution; AI boxes appear only for fresh, time-aligned detections.</span>
      <a href="https://www.511ia.org/" target="_blank" rel="noreferrer">Open Iowa 511</a>
      <a href="https://www.arcgis.com/home/item.html?id=c4063f200a7b4da5826e2ac86c677cf5" target="_blank" rel="noreferrer">Iowa DOT camera data · CC BY 4.0</a>
    </footer>
  </section>;
}
