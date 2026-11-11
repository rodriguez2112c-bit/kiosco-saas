import { useEffect, useRef } from "react";

declare global { interface Window { BarcodeDetector?: any } }

/** Escáner por cámara (BarcodeDetector: Chrome/Android). Con lector USB/Bluetooth no hace falta: escribe en el buscador. */
export function Camara({ onCodigo, onClose }: { onCodigo: (c: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let parar = false, stream: MediaStream | undefined, ultimo = "", t = 0;
    (async () => {
      if (!window.BarcodeDetector) { alert("Este navegador no soporta escaneo por cámara. Usá un lector USB/Bluetooth."); onClose(); return; }
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      video.current!.srcObject = stream; await video.current!.play();
      const det = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"] });
      const loop = async () => {
        if (parar) return;
        try {
          const r = await det.detect(video.current!);
          if (r[0] && (r[0].rawValue !== ultimo || Date.now() - t > 2000)) { ultimo = r[0].rawValue; t = Date.now(); onCodigo(ultimo); }
        } catch { /* frame no listo */ }
        setTimeout(loop, 250);
      };
      loop();
    })().catch(() => { alert("No se pudo abrir la cámara"); onClose(); });
    return () => { parar = true; stream?.getTracks().forEach((x) => x.stop()); };
  }, []);
  return (
    <div className="modal"><div className="modal-box">
      <video ref={video} playsInline muted style={{ width: "100%", borderRadius: 8 }} />
      <button onClick={onClose}>Cerrar cámara</button>
    </div></div>
  );
}
