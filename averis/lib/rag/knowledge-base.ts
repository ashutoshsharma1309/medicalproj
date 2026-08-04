import type { KnowledgeCategory } from "./types";

/**
 * The medical knowledge base.
 *
 * Educational reference material only. Every entry describes what a
 * measurement *is* and what ranges published guidelines use — never what a
 * particular reading means for a particular person. That line is the whole
 * product rule: AVERIS explains, it does not assess.
 *
 * Each entry carries a citation. A knowledge base a patient cannot trace back
 * to a named guideline is indistinguishable from a model making things up,
 * and "according to AVERIS" is not a source.
 *
 * Two entries carry no lab values at all — `reference-ranges-vary` and
 * `one-result-is-not-a-diagnosis`. They exist because they are the two things
 * most likely to be *missing* from a patient's understanding when they read a
 * flagged result, and because retrieval will surface them for exactly the
 * anxious questions where they matter most.
 */

export type KnowledgeEntry = {
  title: string;
  category: KnowledgeCategory;
  body: string;
  citation: string;
};

export const KNOWLEDGE_BASE: KnowledgeEntry[] = [
  /* ------------------------------------------------------ how to read labs */
  {
    title: "What a reference range means",
    category: "GENERAL_HEALTH",
    body: `A reference range is the interval of results seen in most healthy people tested by that laboratory. It is usually defined so that about 95 percent of a healthy reference population falls inside it — which also means roughly 1 in 20 healthy people fall outside it without anything being wrong.

Ranges are not universal. They differ between laboratories depending on the equipment and method used, and they can differ by age, sex, pregnancy and time of day. This is why a result should be read against the range printed on that same report rather than against a range from elsewhere.

A value slightly outside the range is common and is not by itself a finding. What a result means depends on the whole clinical picture, which is something only a clinician who knows the person can put together.`,
    citation: "National Library of Medicine, MedlinePlus — Understanding Laboratory Tests",
  },
  {
    title: "Why one result is not a diagnosis",
    category: "GENERAL_HEALTH",
    body: `A single laboratory result is one measurement at one moment. Values move with hydration, recent meals, exercise, illness, medication, stress and the time of day the sample was taken. Laboratory measurement itself also has a margin of error.

For this reason clinical guidelines generally require a result to be confirmed — often on a separate day, sometimes with a different test — before it is used to make a diagnosis. Diagnosis also considers symptoms, examination, history and other results together.

An out-of-range value on a report is a reason to have a conversation with a healthcare professional. It is not a conclusion.`,
    citation: "World Health Organization — Laboratory Quality Management System handbook",
  },

  /* ------------------------------------------------------------- diabetes */
  {
    title: "HbA1c (glycated haemoglobin)",
    category: "LAB_REFERENCE",
    body: `HbA1c measures the proportion of haemoglobin in the blood that has glucose attached to it. Because red blood cells live for about three months, HbA1c reflects average blood glucose over roughly the preceding 8 to 12 weeks rather than at the moment of the test. It does not require fasting.

The American Diabetes Association describes these categories for adults who are not pregnant: below 5.7 percent is considered normal; 5.7 to 6.4 percent is the range described as prediabetes; 6.5 percent or above on two separate tests is one of the criteria used for diagnosing diabetes.

HbA1c can be unreliable in some situations, including certain anaemias, haemoglobin variants, recent blood transfusion, pregnancy, and kidney or liver disease, because these change how long red blood cells survive.`,
    citation: "American Diabetes Association — Standards of Care in Diabetes, Classification and Diagnosis",
  },
  {
    title: "Fasting plasma glucose",
    category: "LAB_REFERENCE",
    body: `Fasting plasma glucose measures the amount of glucose in the blood after at least eight hours without food or drink other than water. It is a snapshot rather than an average.

The American Diabetes Association describes these categories: below 100 mg/dL (5.6 mmol/L) is considered normal; 100 to 125 mg/dL (5.6 to 6.9 mmol/L) is the range described as impaired fasting glucose, or prediabetes; 126 mg/dL (7.0 mmol/L) or above, confirmed on a repeat test, is one of the criteria used for diagnosing diabetes.

Eating shortly before the test, illness and some medications including corticosteroids can raise the result, which is one reason a single value is confirmed before it is acted on.`,
    citation: "American Diabetes Association — Standards of Care in Diabetes, Classification and Diagnosis",
  },
  {
    title: "Metformin",
    category: "MEDICATION",
    body: `Metformin is a medicine used in the management of type 2 diabetes. It lowers blood glucose mainly by reducing the amount of glucose the liver releases and by making the body's tissues more responsive to insulin. It does not work by causing the pancreas to release more insulin, which is why on its own it carries a low risk of hypoglycaemia.

Major guidelines commonly describe metformin as a first-line medicine for type 2 diabetes alongside diet and physical activity. Common side effects are digestive and often settle with time or with a slower increase in dose. Kidney function is usually checked before starting and periodically afterwards.

Decisions about starting, changing or stopping any medicine belong with the doctor who knows the person's full history.`,
    citation: "National Institute for Health and Care Excellence (NICE) — Type 2 diabetes in adults: management",
  },

  /* --------------------------------------------------------- lipids */
  {
    title: "LDL cholesterol",
    category: "LAB_REFERENCE",
    body: `LDL stands for low-density lipoprotein. It is often called "bad cholesterol" because LDL particles carry cholesterol into the artery wall, where it contributes to the plaque build-up of atherosclerosis. Higher LDL levels over time are associated with higher cardiovascular risk at a population level.

Commonly cited categories for adults are: below 100 mg/dL described as optimal; 100 to 129 mg/dL near or above optimal; 130 to 159 mg/dL borderline high; 160 to 189 mg/dL high; and 190 mg/dL or above very high.

Modern guidelines set targets according to a person's overall cardiovascular risk rather than by LDL alone, so the level that matters for one person is not the level that matters for another.`,
    citation: "National Heart, Lung, and Blood Institute — ATP III guidelines on cholesterol",
  },
  {
    title: "HDL cholesterol",
    category: "LAB_REFERENCE",
    body: `HDL stands for high-density lipoprotein and is often called "good cholesterol". HDL particles carry cholesterol away from tissues and back to the liver, and at a population level higher HDL is associated with lower cardiovascular risk.

Commonly cited thresholds describe HDL below 40 mg/dL in men and below 50 mg/dL in women as low, and 60 mg/dL or above as a level associated with lower risk.

Unlike LDL, raising HDL with medicines has not been shown to reduce cardiovascular events, so HDL is generally used as part of assessing risk rather than as a target to be treated on its own.`,
    citation: "National Heart, Lung, and Blood Institute — ATP III guidelines on cholesterol",
  },
  {
    title: "Total cholesterol and triglycerides",
    category: "LAB_REFERENCE",
    body: `Total cholesterol is the combined measure of cholesterol carried in all lipoprotein particles. Commonly cited categories for adults are: below 200 mg/dL described as desirable; 200 to 239 mg/dL borderline high; and 240 mg/dL or above high.

Triglycerides are a different kind of fat carried in the blood. Commonly cited categories are: below 150 mg/dL normal; 150 to 199 mg/dL borderline high; 200 to 499 mg/dL high; and 500 mg/dL or above very high. Triglyceride results are strongly affected by recent food and alcohol, which is why the test is often taken fasting.

Because total cholesterol combines both LDL and HDL, it can be misleading on its own — a high HDL raises it without indicating higher risk.`,
    citation: "National Heart, Lung, and Blood Institute — ATP III guidelines on cholesterol",
  },

  /* --------------------------------------------------- blood pressure */
  {
    title: "Blood pressure readings",
    category: "LAB_REFERENCE",
    body: `A blood pressure reading has two numbers written as systolic over diastolic, for example 128/82 mm Hg. Systolic is the pressure while the heart contracts; diastolic is the pressure between beats.

The 2017 American College of Cardiology and American Heart Association guideline describes these categories for adults: normal is below 120 and below 80; elevated is 120 to 129 and below 80; stage 1 is 130 to 139 or 80 to 89; stage 2 is 140 or above, or 90 or above.

Blood pressure varies through the day and rises with stress, caffeine, pain and the act of being measured in a clinic. Guidelines generally require readings on more than one occasion, often including measurements taken at home, before categorising someone.`,
    citation: "American College of Cardiology / American Heart Association — 2017 Guideline for High Blood Pressure in Adults",
  },

  /* ------------------------------------------------------- haematology */
  {
    title: "Haemoglobin and anaemia",
    category: "LAB_REFERENCE",
    body: `Haemoglobin is the protein in red blood cells that carries oxygen. A low haemoglobin concentration is called anaemia, and it is a finding rather than a diagnosis in itself — the reason for it still has to be established.

The World Health Organization has commonly used thresholds of below 13.0 g/dL in men and below 12.0 g/dL in non-pregnant women, with a lower threshold of 11.0 g/dL used in pregnancy. Laboratories publish their own ranges and these differ somewhat.

Anaemia has many possible causes, including low iron, blood loss, vitamin B12 or folate deficiency, chronic illness and inherited conditions. Which applies is worked out from further tests and from the person's history.`,
    citation: "World Health Organization — Haemoglobin concentrations for the diagnosis of anaemia",
  },
  {
    title: "Thyroid stimulating hormone (TSH)",
    category: "LAB_REFERENCE",
    body: `TSH is made by the pituitary gland and tells the thyroid how much thyroid hormone to produce. It is usually the first test used to assess thyroid function.

Most laboratories use a reference range of approximately 0.4 to 4.0 mIU/L for adults, though this varies by laboratory, by age, and in pregnancy. The relationship is inverse: a high TSH usually suggests the thyroid is underactive, because the pituitary is signalling harder, while a low TSH usually suggests it is overactive.

TSH is normally interpreted together with free T4, and results can be temporarily affected by other illness, so an abnormal value is often repeated before conclusions are drawn.`,
    citation: "American Thyroid Association — Thyroid Function Tests",
  },

  /* --------------------------------------------------------- kidney */
  {
    title: "Creatinine and eGFR (kidney function)",
    category: "LAB_REFERENCE",
    body: `Creatinine is a waste product from normal muscle activity that healthy kidneys filter out of the blood. Because the amount produced depends on muscle mass, creatinine alone is interpreted alongside an estimated glomerular filtration rate, or eGFR, which is calculated from creatinine together with age and sex.

eGFR is reported in mL/min/1.73 m². A value of 90 or above with no other sign of kidney damage is generally considered normal kidney function. KDIGO guidance describes an eGFR persistently below 60 for three months or more as one of the criteria for chronic kidney disease.

A single reduced eGFR can follow dehydration, some medicines, or a recent high-protein meal, so persistence over time is part of the definition rather than an afterthought.`,
    citation: "KDIGO — Clinical Practice Guideline for the Evaluation and Management of Chronic Kidney Disease",
  },

  /* ------------------------------------------------------ body measures */
  {
    title: "Body mass index (BMI)",
    category: "GENERAL_HEALTH",
    body: `BMI is weight in kilograms divided by height in metres squared. It is a screening measure for population studies, not a measure of an individual's health or body composition.

The World Health Organization categories for adults are: below 18.5 underweight; 18.5 to 24.9 normal range; 25.0 to 29.9 overweight; and 30.0 or above obesity. Some health bodies use lower thresholds for people of South Asian, Chinese and other Asian ancestry, because cardiometabolic risk rises at a lower BMI in these populations.

BMI does not distinguish muscle from fat and does not describe where fat is carried, which is why it is a poor guide for individuals such as athletes and is usually considered alongside other measures.`,
    citation: "World Health Organization — Body mass index classification",
  },
  {
    title: "Vitamin D (25-hydroxyvitamin D)",
    category: "LAB_REFERENCE",
    body: `Vitamin D status is usually measured as 25-hydroxyvitamin D in the blood. Vitamin D contributes to calcium absorption and bone health, and the body makes it in skin exposed to sunlight as well as obtaining it from food.

Commonly cited thresholds describe below 12 ng/mL (30 nmol/L) as deficiency, 12 to 20 ng/mL (30 to 50 nmol/L) as insufficiency for bone health in most people, and 20 ng/mL (50 nmol/L) or above as adequate for most people. Units differ between laboratories: ng/mL and nmol/L are not interchangeable and differ by a factor of about 2.5.

Guidance on supplementation varies between countries and depends on individual circumstances.`,
    citation: "National Institutes of Health, Office of Dietary Supplements — Vitamin D Fact Sheet",
  },

  /* ------------------------------------------------------- conditions */
  {
    title: "Type 2 diabetes",
    category: "CONDITION",
    body: `Type 2 diabetes is a long-term condition in which blood glucose stays higher than the normal range, because the body's tissues respond less well to insulin and the pancreas cannot fully compensate. It develops gradually and can be present for years without noticeable symptoms.

It is generally identified through blood tests — fasting plasma glucose, HbA1c, or an oral glucose tolerance test — with an abnormal result confirmed on a second occasion. Monitoring commonly includes periodic HbA1c, blood pressure, lipid profile, kidney function, and eye and foot checks.

Management usually combines eating patterns, physical activity and, where appropriate, medicines, all decided with a healthcare team who know the person's circumstances.`,
    citation: "American Diabetes Association — Standards of Care in Diabetes",
  },
  {
    title: "High blood pressure (hypertension)",
    category: "CONDITION",
    body: `Hypertension is persistently raised blood pressure. It usually causes no symptoms, which is why it is often found during routine measurement rather than because someone feels unwell. Over years, sustained high blood pressure increases the risk of stroke, heart disease and kidney disease.

It is identified from repeated readings rather than a single measurement, and guidelines commonly describe confirming clinic readings with measurements taken at home or over 24 hours, because blood pressure is often higher in a clinical setting.

Management may involve changes to diet, physical activity, alcohol and salt intake, and medicines where a clinician judges them appropriate.`,
    citation: "American College of Cardiology / American Heart Association — 2017 Guideline for High Blood Pressure in Adults",
  },
];

/** Split into the entries that get embedded, keyed for stable seeding. */
export function knowledgeEntryCount(): number {
  return KNOWLEDGE_BASE.length;
}
