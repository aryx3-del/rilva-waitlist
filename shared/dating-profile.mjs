export const GENDER_OPTIONS = [
  { value: 'woman', label: 'Woman' },
  { value: 'man', label: 'Man' },
  { value: 'nonbinary', label: 'Nonbinary' },
];

export function normalizeProfile(input) {
  const text = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return {
    ...input,
    name: text(input.name), city: text(input.city), bio: text(input.bio),
    gender: text(input.gender).toLowerCase(),
    lookingFor: Array.isArray(input.lookingFor)
      ? [...new Set(input.lookingFor.map(value => text(value).toLowerCase()))] : [],
  };
}

export function validateProfile(input) {
  const p = normalizeProfile(input);
  const genders = new Set(GENDER_OPTIONS.map(option => option.value));
  if (p.name.length < 2 || p.name.length > 40) return 'Enter a display name between 2 and 40 characters.';
  if (!Number.isInteger(p.age) || p.age < 18 || p.age > 100) return 'Enter your age, from 18 to 100.';
  if (!genders.has(p.gender)) return 'Choose your gender.';
  if (!p.lookingFor.length || p.lookingFor.length > 3 || p.lookingFor.some(value => !genders.has(value))) return 'Choose who you would like to meet.';
  if (!Number.isInteger(p.minAge) || !Number.isInteger(p.maxAge) || p.minAge < 18 || p.maxAge > 100 || p.minAge > p.maxAge) return 'Choose an age range from 18 to 100, with the minimum first.';
  if (p.city.length < 2 || p.city.length > 60) return 'Enter your city, between 2 and 60 characters.';
  if (p.bio.length > 500) return 'Keep your bio within 500 characters.';
  if (!['Meaningful', 'Exploring', 'Meeting people'].includes(p.intention)) return 'Choose your dating intention.';
  if (!['Slow & thoughtful', 'A little of both', 'Meet sooner'].includes(p.pace)) return 'Choose your preferred pace.';
  if (!Array.isArray(p.interests) || p.interests.length > 12 || p.interests.some(value => typeof value !== 'string' || value.trim().length < 2 || value.trim().length > 32)) return 'Add up to 12 interests, each between 2 and 32 characters.';
  return '';
}
