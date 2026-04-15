import Link from "next/link";
import styles from "./logo.module.css";

export function Logo() {
  return (
    <Link href="/" className={styles.logo}>
      <span className={styles.logo__primary}>Player Pool</span>
      <span className={styles.logo__secondary}>NBA Playoffs</span>
    </Link>
  );
}
