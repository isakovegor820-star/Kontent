export function GET(_request: Request) {
  void _request;
  return new Response(null, {
    status: 308,
    headers: { location: "/icon.svg" },
  });
}
