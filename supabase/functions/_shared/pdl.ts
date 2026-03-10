import { getOptionalEnv } from './env.ts';

const PDL_API_KEY = getOptionalEnv('PDL_API_KEY');
const PDL_BASE = 'https://api.peopledatalabs.com/v5/person/enrich';

export interface PDLExperience {
  title: string | null;
  companyName: string | null;
  companyIndustry: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface PDLProfile {
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  jobTitle: string | null;
  jobCompanyName: string | null;
  jobCompanyIndustry: string | null;
  jobCompanySize: string | null;
  jobStartDate: string | null;
  industry: string | null;
  inferredYearsExperience: number | null;
  locationName: string | null;
  locationLocality: string | null;
  locationRegion: string | null;
  locationCountry: string | null;
  educationSchool: string | null;
  educationDegrees: string[] | null;
  educationMajors: string[] | null;
  interests: string[] | null;
  experience: PDLExperience[] | null;
  likelihood: number;
}

// deno-lint-ignore no-explicit-any
function parseExperience(raw: any[]): PDLExperience[] {
  return raw
    .filter((e) => e.title?.name || e.company?.name)
    .slice(0, 5)
    .map((e) => ({
      title: e.title?.name ?? null,
      companyName: e.company?.name ?? null,
      companyIndustry: e.company?.industry ?? null,
      startDate: e.start_date ?? null,
      endDate: e.end_date ?? null,
    }));
}

function findCurrentJob(
  experience: PDLExperience[],
  // deno-lint-ignore no-explicit-any
  topLevel: any,
): { title: string | null; company: string | null; industry: string | null; startDate: string | null } {
  const current = experience.filter((e) => !e.endDate && e.title);
  if (current.length > 0) {
    const sorted = [...current].sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''));
    const best = sorted[0];
    return { title: best.title, company: best.companyName, industry: best.companyIndustry, startDate: best.startDate };
  }
  return {
    title: topLevel.job_title ?? null,
    company: topLevel.job_company_name ?? null,
    industry: topLevel.job_company_industry ?? null,
    startDate: topLevel.job_start_date ?? null,
  };
}

// deno-lint-ignore no-explicit-any
function parseProfile(body: any): PDLProfile | null {
  const d = body.data ?? body;
  const likelihood: number = body.likelihood ?? d.likelihood ?? 0;
  const edu = Array.isArray(d.education) && d.education.length > 0 ? d.education[0] : null;
  const experience = Array.isArray(d.experience) ? parseExperience(d.experience) : [];
  const job = findCurrentJob(experience, d);

  return {
    fullName: d.full_name ?? null,
    firstName: d.first_name ?? null,
    lastName: d.last_name ?? null,
    headline: d.headline ?? null,
    jobTitle: job.title,
    jobCompanyName: job.company,
    jobCompanyIndustry: job.industry,
    jobCompanySize: d.job_company_size ?? null,
    jobStartDate: job.startDate,
    industry: d.industry ?? null,
    inferredYearsExperience: d.inferred_years_experience ?? null,
    locationName: d.location_name ?? null,
    locationLocality: d.location_locality ?? null,
    locationRegion: d.location_region ?? null,
    locationCountry: d.location_country ?? null,
    educationSchool: edu?.school?.name ?? null,
    educationDegrees: Array.isArray(edu?.degrees) && edu.degrees.length > 0 ? edu.degrees : null,
    educationMajors: Array.isArray(edu?.majors) && edu.majors.length > 0 ? edu.majors : null,
    interests: Array.isArray(d.interests) && d.interests.length > 0 ? d.interests : null,
    experience: experience.length > 0 ? experience : null,
    likelihood,
  };
}

export async function enrichByPhone(phone: string): Promise<PDLProfile | null> {
  if (!PDL_API_KEY) return null;

  const cleaned = phone.replace(/\s+/g, '');
  if (!cleaned.startsWith('+')) return null;

  const params = new URLSearchParams({
    phone: cleaned,
    min_likelihood: '3',
  });

  try {
    const resp = await fetch(`${PDL_BASE}?${params}`, {
      headers: { 'X-Api-Key': PDL_API_KEY, Accept: 'application/json' },
    });

    if (resp.status === 404 || !resp.ok) return null;

    return parseProfile(await resp.json());
  } catch (e) {
    console.error('[pdl] enrichment failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

export function profileToContext(profile: PDLProfile): string {
  const lines: string[] = [];

  if (profile.fullName) lines.push(`Name: ${profile.fullName}`);
  if (profile.jobTitle) lines.push(`Current Title: ${profile.jobTitle}`);
  if (profile.jobCompanyName) {
    let line = `Company: ${profile.jobCompanyName}`;
    if (profile.jobCompanySize) line += ` (${profile.jobCompanySize} employees)`;
    lines.push(line);
  }
  if (profile.jobCompanyIndustry) lines.push(`Industry: ${profile.jobCompanyIndustry}`);
  if (profile.inferredYearsExperience != null) lines.push(`Experience: ~${profile.inferredYearsExperience} years`);

  if (profile.experience && profile.experience.length > 1) {
    lines.push('Work History:');
    for (const exp of profile.experience) {
      const dates = exp.startDate ? `${exp.startDate} - ${exp.endDate ?? 'present'}` : '';
      lines.push(`  - ${exp.title ?? '?'} @ ${exp.companyName ?? '?'} (${dates})`);
    }
  }

  if (profile.educationSchool) {
    let line = `Education: ${profile.educationSchool}`;
    if (profile.educationMajors) line += ` (${profile.educationMajors.join(', ')})`;
    lines.push(line);
  }

  if (profile.locationName) {
    lines.push(`Location: ${profile.locationName}`);
  } else if (profile.locationLocality) {
    lines.push(`Location: ${profile.locationLocality}${profile.locationRegion ? `, ${profile.locationRegion}` : ''}`);
  }

  if (profile.interests && profile.interests.length > 0) {
    lines.push(`Interests: ${profile.interests.join(', ')}`);
  }

  return lines.join('\n');
}
