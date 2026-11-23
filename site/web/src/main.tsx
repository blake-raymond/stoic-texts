import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

declare global {
  interface Window {
    oldCounsel?: {
      track: (name: string, props?: Record<string, unknown>) => void;
    };
  }
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

if (!sessionStorage.getItem("oc_chat_view")) {
  sessionStorage.setItem("oc_chat_view", "1");
  window.oldCounsel?.track("page_view", { referrer: document.referrer || "" });
}
