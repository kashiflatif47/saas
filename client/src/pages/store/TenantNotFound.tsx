/** Shown for /r/<slug> addresses that do not belong to any restaurant (also returned with HTTP 404 by the server). */
export default function TenantNotFound({ slug }: { slug?: string | null }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8 text-center">
      <p className="font-display text-3xl font-semibold">Restaurant not found</p>
      <p className="mt-2 max-w-md text-stone-500">
        {slug ? `There is no restaurant at “${slug}”.` : 'This restaurant address is not valid.'} Check the address or scan the QR code again.
      </p>
    </div>
  );
}
