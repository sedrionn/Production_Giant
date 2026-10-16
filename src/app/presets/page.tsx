import { Presets, SettingsForm } from "@/components/Presets";

export default function PresetsPage() {
  return (
    <div className="mx-auto max-w-[1100px] space-y-12 px-4 py-8">
      <Presets />
      <SettingsForm />
    </div>
  );
}
