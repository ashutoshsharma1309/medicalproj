"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SectionCard } from "@/components/ui";

export type ProfilePrefill = {
  fullName: string;
  dateOfBirth: string;
  gender: string;
  phone: string;
  bloodGroup: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  surgeries: string;
  diseases: string[];
  allergies: string[];
  medications: string[];
};

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "Unknown"];

/** Comma/newline-separated list input with chips preview. */
function ListField({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const items = value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="field min-h-16"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
      {items.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {items.map((i) => (
            <span key={i} className="chip chip-neutral normal-case tracking-normal">{i}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProfileForm({ prefill, firstTime }: { prefill: ProfilePrefill; firstTime: boolean }) {
  const router = useRouter();
  const [f, setF] = useState({
    fullName: prefill.fullName,
    dateOfBirth: prefill.dateOfBirth,
    gender: prefill.gender,
    phone: prefill.phone,
    bloodGroup: prefill.bloodGroup,
    emergencyContactName: prefill.emergencyContactName,
    emergencyContactPhone: prefill.emergencyContactPhone,
    surgeries: prefill.surgeries,
  });
  const [diseases, setDiseases] = useState(prefill.diseases.join(", "));
  const [allergies, setAllergies] = useState(prefill.allergies.join(", "));
  const [medications, setMedications] = useState(prefill.medications.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value });

  const toList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/portal/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...f,
        diseases: toList(diseases),
        allergies: toList(allergies),
        medications: toList(medications),
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not save your profile.");
      return;
    }
    router.push(data.redirect ?? "/portal");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <SectionCard eyebrow="Required" title="Personal information">
        <div className="grid gap-4 px-5 pb-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="p-name">Full name</label>
            <input id="p-name" className="field" value={f.fullName} onChange={set("fullName")} required minLength={2} autoComplete="name" />
          </div>
          <div>
            <label className="label" htmlFor="p-dob">Date of birth</label>
            <input id="p-dob" type="date" className="field mono-data" value={f.dateOfBirth} onChange={set("dateOfBirth")} required max={new Date().toISOString().slice(0, 10)} />
          </div>
          <div>
            <label className="label" htmlFor="p-gender">Gender</label>
            <select id="p-gender" className="field" value={f.gender} onChange={set("gender")} required>
              <option value="" disabled>Select…</option>
              <option>Female</option>
              <option>Male</option>
              <option>Other</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="p-phone">Phone number</label>
            <input id="p-phone" type="tel" className="field" value={f.phone} onChange={set("phone")} required minLength={7} placeholder="(555) 000-0000" autoComplete="tel" />
          </div>
          <div>
            <label className="label" htmlFor="p-blood">Blood group</label>
            <select id="p-blood" className="field mono-data" value={f.bloodGroup} onChange={set("bloodGroup")} required>
              <option value="" disabled>Select…</option>
              {BLOOD_GROUPS.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-faint">Choose “Unknown” if you&rsquo;re not sure — a lab report can fill this in later.</p>
          </div>
        </div>
      </SectionCard>

      <SectionCard eyebrow="Medical information" title="Your health background">
        <div className="space-y-4 px-5 pb-5">
          <ListField
            id="p-diseases"
            label="Existing conditions"
            value={diseases}
            onChange={setDiseases}
            placeholder="e.g. Diabetes, High blood pressure"
            hint="Separate with commas. Leave blank if none."
          />
          <ListField
            id="p-allergies"
            label="Allergies"
            value={allergies}
            onChange={setAllergies}
            placeholder="e.g. Penicillin, Peanuts"
            hint="Medicines, foods or materials. These are shown prominently to every clinician."
          />
          <ListField
            id="p-medications"
            label="Current medications"
            value={medications}
            onChange={setMedications}
            placeholder="e.g. Metformin 500 mg, Lisinopril 10 mg"
            hint="Include the dose if you know it."
          />
          <div>
            <label className="label" htmlFor="p-surgeries">Previous surgeries</label>
            <textarea
              id="p-surgeries"
              className="field min-h-16"
              value={f.surgeries}
              onChange={set("surgeries")}
              placeholder="e.g. Appendectomy (2015), Knee arthroscopy (2021)"
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard eyebrow="In case of emergency" title="Emergency contact">
        <div className="grid gap-4 px-5 pb-5 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="p-ecname">Contact name</label>
            <input id="p-ecname" className="field" value={f.emergencyContactName} onChange={set("emergencyContactName")} placeholder="e.g. Anita Sharma (spouse)" />
          </div>
          <div>
            <label className="label" htmlFor="p-ecphone">Contact phone</label>
            <input id="p-ecphone" type="tel" className="field" value={f.emergencyContactPhone} onChange={set("emergencyContactPhone")} placeholder="(555) 000-0000" />
          </div>
        </div>
      </SectionCard>

      {error && (
        <p className="rounded-md border border-critical-line bg-critical-wash px-3 py-2 text-[13px] text-critical">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs leading-relaxed text-faint">
          Saving adds to your record — it never deletes information entered by your care team.
        </p>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : firstTime ? "Save & continue" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
