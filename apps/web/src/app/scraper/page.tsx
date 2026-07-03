import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocalDevelopmentHeaders } from "@/lib/local-dev";
import { ScraperControlPanel } from "../ScraperControlPanel";
import styles from "../page.module.css";

export const dynamic = "force-dynamic";

function PaperlesspaperLogo({ className }: { className?: string }) {
  return <span className={className}>paperlesspaper</span>;
}

export default async function ScraperPage() {
  const requestHeaders = await headers();

  if (!isLocalDevelopmentHeaders(requestHeaders)) {
    notFound();
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.header}>
          <h1 className={styles.headerTitle}>
            <PaperlesspaperLogo className={styles.logoLarge} />
          </h1>
          <div className={styles.artLabel}>Scraper</div>
          <nav className={styles.headerLinks} aria-label="Project links">
            <Link href="/">Art catalog</Link>
            <a href="https://github.com/paperlesspaper/paperlesspaper-art">
              GitHub project
            </a>
          </nav>
        </div>

        <ScraperControlPanel />
      </main>
    </div>
  );
}
