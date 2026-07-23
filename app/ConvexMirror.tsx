"use client";

import { PointerEvent, useCallback, useEffect, useRef, useState } from "react";

type Landmark = { x: number; y: number; z: number };
type HandsResult = { multiHandLandmarks?: Landmark[][] };
type HandsInstance = {
  setOptions: (options: Record<string, unknown>) => void;
  onResults: (callback: (result: HandsResult) => void) => void;
  send: (payload: { image: HTMLVideoElement }) => Promise<void>;
  close: () => Promise<void>;
};

declare global {
  interface Window {
    Hands?: new (config: {
      locateFile: (file: string) => string;
    }) => HandsInstance;
  }
}

const vertexShader = `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = a_position * .5 + .5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const fragmentShader = `
  precision highp float;
  uniform sampler2D u_image;
  uniform vec2 u_pointer;
  uniform float u_push;
  uniform float u_videoAspect;
  uniform float u_ready;
  varying vec2 v_uv;

  float convexScale(float normalizedRadius) {
    float radius2 = normalizedRadius * normalizedRadius;
    float radius4 = radius2 * radius2;
    return .64 + .24 * radius2 + .12 * radius4;
  }

  void main() {
    if (u_ready < .5) {
      gl_FragColor = vec4(0.0);
      return;
    }

    vec2 uv = v_uv;
    vec2 centered = uv - .5;
    float radius = length(centered);

    // Aspheric convex-mirror projection. The shallow center enlarges nearby
    // subjects, then the curve accelerates toward the rim to compress the
    // surrounding scene without producing straight radial streaks.
    float normalizedRadius = clamp(radius * 2.0, 0.0, 1.0);
    float sphericalScale = convexScale(normalizedRadius);
    vec2 warped = .5 + centered * sphericalScale;

    // Model a finger press as a continuous elastic lens. The core magnifies
    // smoothly and a faint counter-compression ring makes the glass feel like
    // one flexible surface instead of a digital pinch filter.
    vec2 pointerFromCenter = u_pointer - .5;
    float pointerRadius = clamp(length(pointerFromCenter) * 2.0, 0.0, 1.0);
    vec2 warpedPointer =
      .5 + pointerFromCenter * convexScale(pointerRadius);
    vec2 displayDelta = uv - u_pointer;
    vec2 sampleDelta = warped - warpedPointer;
    float pressDistance2 = dot(displayDelta, displayDelta);
    float pressCore = exp(-pressDistance2 * 48.0);
    float pressOuter = exp(-pressDistance2 * 16.0);
    float elasticRing = max(pressOuter - pressCore, 0.0);
    float pressScale =
      1.0 - u_push * (.54 * pressCore - .10 * elasticRing);
    warped = warpedPointer + sampleDelta * pressScale;

    // Finger pushes can approach the rim, so keep the final sample bounded
    // inside the circular camera field instead of stretching edge pixels.
    vec2 fromCenter = warped - .5;
    float warpedRadius = length(fromCenter);
    if (warpedRadius > .499) {
      warped = .5 + (fromCenter / warpedRadius) * .499;
    }

    // Cover-crop the camera texture and mirror it like a real reflection.
    vec2 cameraUv = warped;
    if (u_videoAspect > 1.0) {
      cameraUv.x = (cameraUv.x - .5) / u_videoAspect + .5;
    } else {
      cameraUv.y = (cameraUv.y - .5) * u_videoAspect + .5;
    }
    cameraUv.x = 1.0 - cameraUv.x;
    cameraUv = clamp(cameraUv, .001, .999);

    vec3 color = texture2D(u_image, cameraUv).rgb;
    float edgeShade = smoothstep(.62, 1.0, normalizedRadius) * .19;
    float highlight =
      smoothstep(.34, 0.0, length(uv - vec2(.35, .25))) * .075;
    color = color * (1.0 - edgeShade) + highlight;
    color = pow(color, vec3(.94));
    gl_FragColor = vec4(color, 1.0);
  }
`;

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function landmarkDistance(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z - b.z) * 0.7);
}

function jointAngle(a: Landmark, joint: Landmark, b: Landmark) {
  const first = {
    x: a.x - joint.x,
    y: a.y - joint.y,
    z: (a.z - joint.z) * 0.7,
  };
  const second = {
    x: b.x - joint.x,
    y: b.y - joint.y,
    z: (b.z - joint.z) * 0.7,
  };
  const firstLength = Math.hypot(first.x, first.y, first.z);
  const secondLength = Math.hypot(second.x, second.y, second.z);
  if (firstLength < 0.0001 || secondLength < 0.0001) return 0;
  const cosine = clamp(
    (first.x * second.x + first.y * second.y + first.z * second.z) /
      (firstLength * secondLength),
    -1,
    1,
  );
  return (Math.acos(cosine) * 180) / Math.PI;
}

function createShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

const fallbackCaptions = [
  "caught in the curve",
  "looks different from here",
  "wide angle mood",
  "the mirror made me do it",
  "seen from the corner",
  "a little out of shape",
];

export function ConvexMirror() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const frameImageRef = useRef<HTMLImageElement>(null);
  const pointerRef = useRef({ x: 0.5, y: 0.46, push: 0 });
  const targetRef = useRef({ x: 0.5, y: 0.46, push: 0 });
  const streamRef = useRef<MediaStream | null>(null);
  const handsRef = useRef<HandsInstance | null>(null);
  const trackingFrameRef = useRef(0);
  const gestureEvidenceRef = useRef(0);
  const filteredFingerRef = useRef({ x: 0.5, y: 0.46 });
  const pointerInsideRef = useRef(false);
  const [cameraState, setCameraState] = useState<
    "idle" | "starting" | "live" | "error"
  >("idle");
  const [tracking, setTracking] = useState<
    "loading" | "searching" | "locked" | "pointer"
  >("loading");
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [photoCaption, setPhotoCaption] = useState("");
  const [flash, setFlash] = useState(false);
  const [legalView, setLegalView] = useState<"privacy" | "terms" | null>(
    null,
  );

  useEffect(() => {
    if (!legalView) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLegalView(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [legalView]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      setCameraState("error");
      return;
    }

    const vertex = createShader(gl, gl.VERTEX_SHADER, vertexShader);
    const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentShader);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.useProgram(program);

    const position = gl.getAttribLocation(program, "a_position");
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    const pointerLocation = gl.getUniformLocation(program, "u_pointer");
    const pushLocation = gl.getUniformLocation(program, "u_push");
    const aspectLocation = gl.getUniformLocation(program, "u_videoAspect");
    const readyLocation = gl.getUniformLocation(program, "u_ready");
    let frame = 0;

    const render = () => {
      const size = Math.min(
        1280,
        Math.max(640, Math.round(canvas.clientWidth * devicePixelRatio)),
      );
      if (canvas.width !== size || canvas.height !== size) {
        canvas.width = size;
        canvas.height = size;
      }
      gl.viewport(0, 0, size, size);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const current = pointerRef.current;
      const target = targetRef.current;
      current.x += (target.x - current.x) * 0.18;
      current.y += (target.y - current.y) * 0.18;
      const pressureEase = target.push < current.push ? 0.34 : 0.14;
      current.push += (target.push - current.push) * pressureEase;
      gl.uniform2f(pointerLocation, current.x, 1 - current.y);
      gl.uniform1f(pushLocation, current.push);
      gl.uniform1f(
        aspectLocation,
        video.videoWidth && video.videoHeight
          ? video.videoWidth / video.videoHeight
          : 1,
      );

      const ready = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
      gl.uniform1f(readyLocation, ready ? 1 : 0);
      if (ready) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          video,
        );
      }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      frame = requestAnimationFrame(render);
    };
    render();

    return () => {
      cancelAnimationFrame(frame);
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
    };
  }, []);

  const startHandTracking = useCallback(() => {
    if (handsRef.current) return;

    const initializeHands = () => {
      if (!window.Hands || !videoRef.current) {
        setTracking("pointer");
        return;
      }
      const hands = new window.Hands({
        locateFile: (file) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`,
      });
      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.65,
        minTrackingConfidence: 0.6,
        selfieMode: true,
      });
      hands.onResults((result) => {
        // The last mouse position owns the dent only while the pointer remains
        // over the glass, so hand tracking cannot erase a stationary hover.
        if (pointerInsideRef.current) {
          return;
        }

        const hand = result.multiHandLandmarks?.[0];
        if (!hand) {
          // Release the physical dent immediately. The evidence counter only
          // stabilizes the status label and must never hold pressure onscreen.
          targetRef.current.push = 0;
          gestureEvidenceRef.current = Math.max(
            -5,
            gestureEvidenceRef.current - 1,
          );
          if (gestureEvidenceRef.current <= -3) {
            setTracking("searching");
          }
          return;
        }
        const tip = hand[8];
        const pip = hand[6];
        const dip = hand[7];
        const indexBase = hand[5];
        const wrist = hand[0];
        const middle = hand[9];

        // Orientation-independent pointing: accept a straight index finger
        // in any screen direction, or a fingertip clearly aimed at the camera.
        const pipAngle = jointAngle(indexBase, pip, dip);
        const dipAngle = jointAngle(pip, dip, tip);
        const extendedByReach =
          landmarkDistance(tip, indexBase) >
          landmarkDistance(pip, indexBase) * 1.42;
        const towardCamera =
          tip.z < pip.z - 0.035 && tip.z < wrist.z - 0.055;
        const indexExtended =
          (pipAngle > 142 && dipAngle > 145 && extendedByReach) ||
          towardCamera;

        gestureEvidenceRef.current = clamp(
          gestureEvidenceRef.current + (indexExtended ? 1 : -1),
          -5,
          5,
        );
        if (gestureEvidenceRef.current < 2) {
          targetRef.current.push = 0;
          if (gestureEvidenceRef.current <= -2) {
            setTracking("searching");
          }
          return;
        }

        // Adaptive smoothing removes landmark jitter without making fast
        // gestures feel delayed.
        const filtered = filteredFingerRef.current;
        const movement = Math.hypot(tip.x - filtered.x, tip.y - filtered.y);
        const smoothing = clamp(0.42 + movement * 4.2, 0.42, 0.86);
        filtered.x += (tip.x - filtered.x) * smoothing;
        filtered.y += (tip.y - filtered.y) * smoothing;

        // MediaPipe reports coordinates in the full rectangular camera
        // image. The shader first cover-crops that image into a square mirror,
        // so invert that crop before using the point as a dent origin.
        const video = videoRef.current;
        const cameraAspect =
          video?.videoWidth && video.videoHeight
            ? video.videoWidth / video.videoHeight
            : 1;
        let mirrorX = filtered.x;
        let mirrorY = filtered.y;
        if (cameraAspect > 1) {
          mirrorX = (filtered.x - 0.5) * cameraAspect + 0.5;
        } else {
          mirrorY = (filtered.y - 0.5) / Math.max(cameraAspect, 0.01) + 0.5;
        }

        const palmSize = Math.hypot(middle.x - wrist.x, middle.y - wrist.y);
        const handProximity = clamp((palmSize - 0.075) * 4.2);
        const fingerDepth = clamp(
          ((pip.z - tip.z) / Math.max(palmSize, 0.06) - 0.08) * 1.35,
        );
        const depth = clamp(
          0.2 + handProximity * 0.35 + fingerDepth * 0.55,
          0.2,
          1,
        );
        targetRef.current = {
          x: clamp(mirrorX),
          y: clamp(mirrorY),
          push: depth,
        };
        setTracking("locked");
      });
      handsRef.current = hands;
      setTracking("searching");

      let detecting = false;
      let lastDetection = 0;
      const detect = async (time: number) => {
        const video = videoRef.current;
        if (
          video &&
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          !detecting &&
          time - lastDetection > 48
        ) {
          detecting = true;
          lastDetection = time;
          try {
            await hands.send({ image: video });
          } catch {
            setTracking("pointer");
          } finally {
            detecting = false;
          }
        }
        trackingFrameRef.current = requestAnimationFrame(detect);
      };
      trackingFrameRef.current = requestAnimationFrame(detect);
    };

    if (window.Hands) {
      initializeHands();
      return;
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      "[data-mediapipe-hands]",
    );
    if (existingScript) {
      existingScript.addEventListener("load", initializeHands, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src =
      "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/hands.min.js";
    script.crossOrigin = "anonymous";
    script.dataset.mediapipeHands = "true";
    script.addEventListener("load", initializeHands, { once: true });
    script.onerror = () => setTracking("pointer");
    document.head.appendChild(script);
  }, []);

  const startCamera = useCallback(async () => {
    if (cameraState === "starting" || cameraState === "live") return;
    setCameraState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 1280 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraState("live");
      startHandTracking();
    } catch {
      setCameraState("error");
      setTracking("pointer");
    }
  }, [cameraState, startHandTracking]);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      cancelAnimationFrame(trackingFrameRef.current);
      void handsRef.current?.close();
    },
    [],
  );

  const movePushPoint = (event: PointerEvent<HTMLDivElement>) => {
    const rect = mirrorRef.current?.getBoundingClientRect();
    if (!rect || cameraState !== "live") return;
    if (event.pointerType === "mouse") {
      pointerInsideRef.current = true;
    }
    targetRef.current = {
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height),
      push: event.buttons ? 1 : 0.48,
    };
    setTracking("pointer");
  };

  const capture = useCallback(async () => {
    const canvas = canvasRef.current;
    const frameImage = frameImageRef.current;
    if (!canvas || !frameImage || cameraState !== "live") return;
    if (!frameImage.complete) {
      await frameImage.decode().catch(() => undefined);
    }

    const output = document.createElement("canvas");
    output.width = 1080;
    output.height = 1220;
    const ctx = output.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#deddd7";
    ctx.fillRect(0, 0, output.width, output.height);
    ctx.fillStyle = "#20201e";
    ctx.font = "600 25px Arial";
    ctx.fillText("convex.camera", 48, 58);

    const frameX = 40;
    const frameY = 92;
    const frameSize = 1000;
    const glassInset = frameSize * 0.1125;
    const glassSize = frameSize - glassInset * 2;
    const glassCenter = frameX + frameSize / 2;
    const glassMiddle = frameY + frameSize / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(glassCenter, glassMiddle, glassSize / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(
      canvas,
      frameX + glassInset,
      frameY + glassInset,
      glassSize,
      glassSize,
    );
    ctx.restore();
    ctx.drawImage(frameImage, frameX, frameY, frameSize, frameSize);

    const caption =
      photoCaption.trim() ||
      fallbackCaptions[Math.floor(Math.random() * fallbackCaptions.length)];
    ctx.fillStyle = "#20201e";
    ctx.textAlign = "left";
    ctx.font = "400 20px Arial";
    ctx.fillText(caption, 48, 1160);
    ctx.textAlign = "right";
    ctx.fillText(
      new Date().toLocaleDateString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
      1032,
      1160,
    );

    setSnapshot(output.toDataURL("image/jpeg", 0.94));
    setFlash(true);
    window.setTimeout(() => setFlash(false), 180);
  }, [cameraState, photoCaption]);

  useEffect(() => {
    const captureWithSpace = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        event.repeat ||
        cameraState !== "live" ||
        snapshot ||
        legalView
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.matches(
          "input, textarea, select, button, a, [contenteditable='true']",
        )
      ) {
        return;
      }
      event.preventDefault();
      void capture();
    };
    window.addEventListener("keydown", captureWithSpace);
    return () => window.removeEventListener("keydown", captureWithSpace);
  }, [cameraState, capture, legalView, snapshot]);

  const download = () => {
    if (!snapshot) return;
    const anchor = document.createElement("a");
    anchor.href = snapshot;
    anchor.download = `convex-cam-${Date.now()}.jpg`;
    anchor.click();
  };

  const trackerLabel = {
    loading: "preparing gesture",
    searching: "point with your index finger",
    locked: "bending",
    pointer: "pointer control",
  }[tracking];

  return (
    <main className="app-shell">
      <header className="site-header">
        <a className="wordmark" href="#" aria-label="Convex Camera home">
          convex.camera
        </a>
        <p className="privacy-note">
          <i aria-hidden="true" />
          camera stays on this device
        </p>
      </header>

      <section className="mirror-stage">
        <div className="mirror-wrap">
          <div className="mirror-rim">
            <div
              className="mirror-surface"
              ref={mirrorRef}
              onPointerEnter={movePushPoint}
              onPointerMove={movePushPoint}
              onPointerDown={(event) => {
                if (cameraState !== "live") return;
                event.currentTarget.setPointerCapture(event.pointerId);
                movePushPoint(event);
              }}
              onPointerUp={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                event.currentTarget.releasePointerCapture(event.pointerId);
                targetRef.current.push =
                  event.pointerType === "mouse" ? 0.48 : 0;
              }}
              onPointerCancel={(event) => {
                pointerInsideRef.current = false;
                targetRef.current.push = 0;
                if (event.pointerType === "mouse") setTracking("searching");
              }}
              onPointerLeave={(event) => {
                if (event.pointerType !== "mouse") return;
                pointerInsideRef.current = false;
                targetRef.current.push = 0;
                setTracking("searching");
              }}
            >
              <canvas ref={canvasRef} aria-label="Live distorted camera mirror" />
              <video ref={videoRef} playsInline muted aria-hidden="true" />
              <div className="mirror-shine" aria-hidden="true" />

              {cameraState !== "live" && (
                <div className="camera-gate">
                  <span className="gate-mark" aria-hidden="true" />
                  <h1>
                    {cameraState === "error"
                      ? "Camera access is blocked."
                      : "Step into the mirror."}
                  </h1>
                  <p>
                    {cameraState === "error"
                      ? "Allow camera access in your browser settings, then try again."
                      : "Your video is processed here and never uploaded."}
                  </p>
                  <button type="button" onClick={startCamera}>
                    {cameraState === "starting"
                      ? "Opening camera…"
                      : cameraState === "error"
                        ? "Try again"
                        : "Allow camera"}
                  </button>
                </div>
              )}
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={frameImageRef}
              className="mirror-frame"
              src="/mirror-frame.png"
              alt=""
              aria-hidden="true"
            />
          </div>
          <div className="mirror-status" aria-live="polite">
            <span data-state={tracking} aria-hidden="true" />
            <p>
              {cameraState === "live"
                ? trackerLabel
                : "camera permission required"}
            </p>
            {cameraState === "live" && (
              <small>or press directly on the glass</small>
            )}
          </div>
        </div>
      </section>

      <footer className="camera-controls">
        <label className="caption-field">
          <span className="sr-only">Photo caption</span>
          <input
            type="text"
            value={photoCaption}
            onChange={(event) => setPhotoCaption(event.target.value)}
            maxLength={48}
            placeholder="add a caption (optional)"
            aria-label="Photo caption"
          />
        </label>
        <div className="capture-control">
          <button
            className="shutter"
            type="button"
            onClick={() => void capture()}
            disabled={cameraState !== "live"}
            aria-label="Take a photo"
            aria-describedby="capture-shortcut"
          >
            <span />
          </button>
          <span id="capture-shortcut" className="capture-shortcut">
            <kbd>space</kbd> to capture
          </span>
        </div>
        <div className="legal-links" aria-label="Legal information">
          <button type="button" onClick={() => setLegalView("privacy")}>
            privacy
          </button>
          <button type="button" onClick={() => setLegalView("terms")}>
            terms
          </button>
        </div>
      </footer>

      {legalView && (
        <div
          className="legal-layer"
          onMouseDown={() => setLegalView(null)}
          role="presentation"
        >
          <section
            className="legal-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="legal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="legal-header">
              <p>convex.camera</p>
              <button
                className="legal-close"
                type="button"
                onClick={() => setLegalView(null)}
                aria-label="Close legal information"
              >
                close
              </button>
            </header>

            <div className="legal-tabs" role="tablist" aria-label="Legal pages">
              <button
                type="button"
                role="tab"
                aria-selected={legalView === "privacy"}
                onClick={() => setLegalView("privacy")}
              >
                Privacy
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={legalView === "terms"}
                onClick={() => setLegalView("terms")}
              >
                Terms of use
              </button>
            </div>

            <article className="legal-copy">
              {legalView === "privacy" ? (
                <>
                  <div className="legal-title-row">
                    <h2 id="legal-title">Privacy</h2>
                    <p>Last updated July 23, 2026</p>
                  </div>
                  <section>
                    <h3>The short version</h3>
                    <p>
                      Convex Camera is designed to process your camera and
                      photos on your device. The app does not create an account,
                      upload your camera feed, or store your photos on its
                      servers.
                    </p>
                  </section>
                  <section>
                    <h3>Camera and gestures</h3>
                    <p>
                      Camera access begins only after you choose “Allow camera.”
                      Video frames are used in your browser to render the mirror
                      and detect your hand position. Hand-tracking software is
                      downloaded from jsDelivr, then runs locally in the page.
                      Your video frames are not sent to jsDelivr.
                    </p>
                  </section>
                  <section>
                    <h3>Photos</h3>
                    <p>
                      Captured images are created in browser memory. Choosing
                      “Save photo” asks your browser to download the file.
                      Unsaved images disappear when the page is refreshed or
                      closed.
                    </p>
                  </section>
                  <section>
                    <h3>Network information</h3>
                    <p>
                      The web host and asset provider may receive standard
                      connection information, such as an IP address, browser
                      type, and request time, when delivering the site files.
                      This MVP does not include advertising trackers, product
                      analytics, or app-owned cookies.
                    </p>
                  </section>
                  <section>
                    <h3>Your control</h3>
                    <p>
                      You can stop the camera by closing the page. You can also
                      revoke camera permission at any time from your browser’s
                      site settings.
                    </p>
                  </section>
                </>
              ) : (
                <>
                  <div className="legal-title-row">
                    <h2 id="legal-title">Terms of use</h2>
                    <p>Last updated July 23, 2026</p>
                  </div>
                  <section>
                    <h3>What this is</h3>
                    <p>
                      Convex Camera is an experimental entertainment tool that
                      creates a distorted live-camera effect. It is provided for
                      personal, playful photo-making.
                    </p>
                  </section>
                  <section>
                    <h3>Use it respectfully</h3>
                    <p>
                      Only photograph people who have agreed to participate.
                      You are responsible for the images you save or share and
                      for following local privacy, publicity, and copyright
                      rules.
                    </p>
                  </section>
                  <section>
                    <h3>Not for safety decisions</h3>
                    <p>
                      The effect is not a real safety mirror, surveillance
                      system, identity tool, or accessibility aid. Do not rely
                      on it for navigation, monitoring, security, medical, or
                      other important decisions.
                    </p>
                  </section>
                  <section>
                    <h3>Age and supervision</h3>
                    <p>
                      If you are below the age required to consent to online
                      services where you live, use Convex Camera with a parent
                      or guardian.
                    </p>
                  </section>
                  <section>
                    <h3>Availability</h3>
                    <p>
                      This prototype is provided as is. Camera support, hand
                      tracking, and downloads can vary by browser and device.
                      The experience may change, pause, or stop without notice.
                    </p>
                  </section>
                </>
              )}
            </article>
          </section>
        </div>
      )}

      {flash && <div className="flash" aria-hidden="true" />}

      {snapshot && (
        <div className="snapshot-view">
          <div className="snapshot-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={snapshot} alt="Your captured convex mirror photo" />
            <div className="snapshot-actions">
              <button type="button" onClick={() => setSnapshot(null)}>
                RETAKE
              </button>
              <button type="button" onClick={download}>
                SAVE PHOTO ↓
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
