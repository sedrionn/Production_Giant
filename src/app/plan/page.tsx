import { Planner } from "@/components/Planner";
import { CATEGORIES } from "@/server/catalog";

export default function PlanPage() {
  return <Planner categories={CATEGORIES} />;
}
