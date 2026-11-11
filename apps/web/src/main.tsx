import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./styles.css";

registerSW({ immediate: true });
// Pide almacenamiento persistente para que el navegador no borre IndexedDB con ventas pendientes.
navigator.storage?.persist?.();
createRoot(document.getElementById("root")!).render(<App />);
