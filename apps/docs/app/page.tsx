import Link from "next/link";

export default function HomePage() {
  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">StripeV2 Documentation</h1>
      <p className="mt-3 text-gray-600">Welcome to the StripeV2 project documentation.</p>
      <Link
        href="/docs/getting-started"
        className="mt-6 inline-block rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
      >
        Get Started
      </Link>
    </div>
  );
}
