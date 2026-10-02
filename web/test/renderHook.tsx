import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach } from "vitest";

const roots = new Set<Root>();

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.replaceChildren();
});

export async function renderHook<T>(hook: () => T) {
  let result: T;
  function Probe() {
    result = hook();
    return null;
  }
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.add(root);
  const rerender = () => act(async () => { root.render(<Probe />); });
  await rerender();
  return { get result() { return result!; }, rerender };
}

export async function renderView(view: () => ReactNode) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.add(root);
  const rerender = () => act(async () => { root.render(view()); });
  await rerender();
  return { node, rerender };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
