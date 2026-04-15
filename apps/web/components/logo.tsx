import Link from "next/link";

export function Logo() {
  return (
    <Link
      href="/"
      className="flex shrink-0 flex-col items-start leading-none mr-2"
    >
      <span className="text-sm font-bold tracking-tight md:text-base">
        Player Pool
      </span>
      <span className="text-[9px] font-semibold uppercase tracking-widest text-orange-500 md:text-[10px]">
        NBA Playoffs
      </span>
    </Link>
  );
}
