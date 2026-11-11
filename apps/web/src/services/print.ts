const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Imprime texto monoespaciado. 32 cols = térmica 58mm, 48 = 80mm, 0 = hoja A4 (sirve para "Guardar como PDF"). */
export function imprimirTexto(texto: string, ancho: 32 | 48 | 0) {
  const f = document.createElement("iframe");
  f.style.cssText = "position:fixed;width:0;height:0;border:0";
  document.body.appendChild(f);
  const d = f.contentWindow!.document;
  const page = ancho === 32 ? "58mm auto" : ancho === 48 ? "80mm auto" : "A4";
  d.open();
  d.write(`<html><head><style>@page{margin:0;size:${page}}body{margin:${ancho ? "2mm" : "15mm"};font:${ancho ? "12px" : "13px"}/1.25 monospace;white-space:pre-wrap}</style></head><body>${esc(texto)}</body></html>`);
  d.close();
  f.contentWindow!.focus();
  f.contentWindow!.print();
  setTimeout(() => f.remove(), 2000);
}
