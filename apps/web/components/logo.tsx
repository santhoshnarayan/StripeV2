import Link from "next/link";

export function Logo() {
  return (
    <Link
      href="/"
      className="hidden md:flex flex-col items-start shrink-0 mr-2 leading-none"
    >
      <span className="text-base font-bold tracking-tight">Player Pool</span>
      <span className="text-[10px] font-semibold text-orange-500 uppercase tracking-widest">
        NBA Playoffs
      </span>
    </Link>
  );
}
