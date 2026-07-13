import fs from 'fs';
import path from 'path';

/*
 * Resolve the app/project root — the directory that holds `public/`, `assets/`,
 * and `build/`. This must work whether the code runs from source (`server/*.ts`
 * under tsx, root = one level up) or compiled (`dist/server/*.js`, root = two
 * levels up), including inside the packaged asar bundle. Rather than hard-coding
 * a depth, walk up from this module until we find the root that contains both
 * `public/` and `package.json`.
 */
export function appRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (
      fs.existsSync(path.join(dir, 'public')) &&
      fs.existsSync(path.join(dir, 'package.json'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  // Fallback to the source layout (server/.. == project root).
  return path.join(__dirname, '..');
}
