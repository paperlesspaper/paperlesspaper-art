import { headers } from "next/headers";
import { isLocalDevelopmentHeaders } from "@/lib/local-dev";
import styles from "./page.module.css";
import { ArtworkCurationGrid } from "./ArtworkCurationGrid";

export const dynamic = "force-dynamic";

function PaperlesspaperLogo({ className }: { className?: string }) {
  return <span className={className}>paperlesspaper</span>;
}

export default async function Home() {
  const requestHeaders = await headers();

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.header}>
          <h1 className={styles.headerTitle}>
            <PaperlesspaperLogo className={styles.logoLarge} />
          </h1>
          <div className={styles.artLabel}>Art</div>
          <nav className={styles.headerLinks} aria-label="Project links">
            <a href="https://paperlesspaper.de">paperlesspaper</a>
            <a href="https://github.com/paperlesspaper/paperlesspaper-art">
              GitHub project
            </a>
          </nav>
        </div>

        <ArtworkCurationGrid
          readOnlyCuration={!isLocalDevelopmentHeaders(requestHeaders)}
        />
      </main>
    </div>
  );
}
