// Tiny escaping template helper: html`<p>${userText}</p>` escapes by default,
// raw(...) and nested html`` fragments are inserted as-is.

export class Safe {
  constructor(public value: string) {}
  toString() {
    return this.value;
  }
}

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(v: unknown): string {
  if (v instanceof Safe) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  let out = strings[0];
  values.forEach((v, i) => (out += render(v) + strings[i + 1]));
  return new Safe(out);
}

export function raw(s: string): Safe {
  return new Safe(s);
}
