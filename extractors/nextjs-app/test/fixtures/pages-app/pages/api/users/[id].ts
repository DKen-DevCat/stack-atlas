export default function handler(
  _req: unknown,
  res: { status(n: number): { json(v: unknown): void } },
) {
  res.status(200).json({});
}
