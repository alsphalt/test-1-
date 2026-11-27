import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The public page is the supplied, self-contained Darknote HTML.
 * It is served verbatim so the design is identical to the source file,
 * without the React layout or global stylesheet changing it.
 */
export const dynamic = "force-static";

const html = readFileSync(path.join(process.cwd(), "public", "darknote.html"), "utf8");

export function GET() {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
