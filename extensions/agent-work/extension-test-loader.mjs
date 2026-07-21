const modules = {
  "@earendil-works/pi-ai": "export const StringEnum = (values) => ({ enum: values });",
  "@earendil-works/pi-tui": "export class Text { constructor(text) { this.text = text; } } export class Editor {} export const Key = {}; export const matchesKey = () => false; export const wrapTextWithAnsi = (x) => [x]; export const truncateToWidth = (x) => x; export const visibleWidth = (x) => x.length;",
  "@earendil-works/pi-coding-agent": "export {};",
  typebox: "export const Type = new Proxy({}, { get: () => (...args) => ({ args }) });",
};
export async function resolve(specifier, context, nextResolve) {
  if (modules[specifier]) return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
  return nextResolve(specifier, context);
}
