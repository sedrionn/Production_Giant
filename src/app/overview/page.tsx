import { Overview } from "@/components/Overview";
import { CATEGORIES } from "@/server/catalog";

export default function OverviewPage() {
  return <Overview categories={CATEGORIES} />;
}
