export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`report template is missing #${id}`);
  return found as T;
}

/**
 * Creates an element; string children become text nodes, so repo-derived strings (paths, patch
 * text, import specifiers) are never parsed as HTML.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Pick<HTMLElementTagNameMap[K], 'className' | 'title'>> & { type?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.className) e.className = props.className;
  if (props.title) e.title = props.title;
  if (props.type) e.setAttribute('type', props.type);
  e.append(...children);
  return e;
}
