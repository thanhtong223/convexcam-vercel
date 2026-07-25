declare global {
  interface Window {
    gtag?: (
      command: "event",
      eventName: string,
      parameters?: Record<string, string | number | boolean>,
    ) => void;
  }
}

export function trackEvent(
  eventName: string,
  parameters?: Record<string, string | number | boolean>,
) {
  if (typeof window === "undefined") return;
  window.gtag?.("event", eventName, {
    transport_type: "beacon",
    ...parameters,
  });
}

export {};
