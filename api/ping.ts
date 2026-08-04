// Diagnostic: confirms Vercel is building & serving the /api functions.
export default function handler(_req: any, res: any) {
  res.status(200).json({ ok: true, ping: "pong" });
}
