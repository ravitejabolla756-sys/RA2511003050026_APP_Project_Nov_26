"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api";
import { PreparedReplay, ReplaySource } from "./PreparedReplay";

type CatalogResponse = { items: ReplaySource[] };

export function DemoReplayGrid() {
  const [sources, setSources] = useState<ReplaySource[]>([]);
  const [message, setMessage] = useState("Loading local demo videos…");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_URL}/demo-media/catalog`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Demo video catalog is unavailable.");
        return await response.json() as CatalogResponse;
      })
      .then(data => {
        setSources(data.items);
        setMessage(data.items.length ? "" : "No allowlisted demo videos are available on this backend.");
      })
      .catch(error => {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Demo video catalog is unavailable.");
      });
    return () => controller.abort();
  }, []);

  return <section className="pageStack" aria-label="Local demo video replays">
    <div className="noticeStrip"><span><strong>LOCAL DEMO VIDEO REPLAYS.</strong> Original clips loop at normal speed; prepared, time-aligned detections keep AI work off the playback path.</span></div>
    {sources.length ? <div className="viewerGrid">{sources.map(source =>
      <PreparedReplay key={source.name} source={source} />
    )}</div> : <p role="status">{message}</p>}
  </section>;
}
