/**
 * Address of a file in /public.
 *
 * Next prefixes links and scripts with the base path on its own, but not the
 * `src` of an image given as a string — and the site is not always served
 * from the root of its host (GitHub Pages serves it under /<repository>).
 */
export const asset = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
