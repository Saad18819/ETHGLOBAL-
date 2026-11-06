import styles from "./home.module.css";
import { Composer } from "@/components/Composer";
import { History } from "@/components/History";

export default function Home() {
  return (
    <main>
      <Composer compact />
      <div className={styles.below}>
        <History />
      </div>
    </main>
  );
}
