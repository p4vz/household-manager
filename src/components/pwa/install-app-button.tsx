"use client";

import { useState, useSyncExternalStore } from "react";
import { installServerSnapshot, installSnapshot, promptInstall, runningAsApp, subscribeInstall } from "./install-prompt";

function subscribeDisplayMode(cb: () => void): () => void {
  const mq = window.matchMedia("(display-mode: standalone)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function useRunningAsApp(): boolean {
  return useSyncExternalStore(subscribeDisplayMode, runningAsApp, () => false);
}

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

/**
 * "Install app" button. On Android Chrome one tap opens Chrome's install
 * dialog. Where the browser gives no such offer (iPhone, Samsung Internet,
 * or Chrome before it decides to offer) the tap shows the menu steps
 * instead. Hidden inside the installed app; says so when it is already on
 * this phone.
 */
export function InstallAppButton({ className = "" }: { className?: string }) {
  const asApp = useRunningAsApp();
  const { canPrompt, installed } = useSyncExternalStore(subscribeInstall, installSnapshot, installServerSnapshot);
  const [help, setHelp] = useState(false);

  if (asApp) return null;

  if (installed) {
    return (
      <p className={`rounded-lg bg-teal-600/10 p-3 text-sm text-teal-900 ${className}`}>
        Aprelev Household is installed on this phone. Open it from your home screen or app drawer.
      </p>
    );
  }

  async function onClick() {
    if (canPrompt && (await promptInstall())) return;
    setHelp((h) => !h);
  }

  return (
    <div className={`space-y-2 ${className}`}>
      <button
        type="button"
        onClick={onClick}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 font-medium text-white hover:bg-teal-700"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Install app on this phone
      </button>
      {help ? <InstallSteps /> : null}
    </div>
  );
}

function InstallSteps() {
  if (isIos()) {
    return (
      <ol className="list-decimal space-y-1 rounded-lg bg-foreground/5 p-3 pl-8 text-sm">
        <li>Open this page in Safari.</li>
        <li>Tap the Share button.</li>
        <li>Tap &ldquo;Add to Home Screen&rdquo;, then &ldquo;Add&rdquo;.</li>
      </ol>
    );
  }
  return (
    <ol className="list-decimal space-y-1 rounded-lg bg-foreground/5 p-3 pl-8 text-sm">
      <li>Open this page in Chrome.</li>
      <li>Tap the &#8942; menu at the top right.</li>
      <li>Tap &ldquo;Add to Home screen&rdquo; (or &ldquo;Install app&rdquo;), then &ldquo;Install&rdquo;.</li>
      <li className="opacity-70">Samsung Internet: tap &#9776;, then &ldquo;Add page to&rdquo;, then &ldquo;Home screen&rdquo;.</li>
    </ol>
  );
}
