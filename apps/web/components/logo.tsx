import Link from "next/link";

export function Logo() {
  return (
    <Link href="/" className="shrink-0 leading-[1]">
      <span className="block text-[11px] font-bold tracking-tight text-foreground">
        Player Pool
      </span>
      <span className="block pt-[1px] text-[7px] font-semibold tracking-[0.26em] text-[#ff5a00] uppercase">
        NBA PLAYOFFS
      </span>
    </Link>
  );
}
