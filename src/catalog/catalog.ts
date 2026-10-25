/** Shared catalog helpers — insurance subtypes + service slug → lead category. */

export const INS_TYPE_SLUG_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export type InsuranceTypePublic = {
  value: string;
  label: string;
  /** File name in `public/images/insurance`, or a full path/URL. */
  image: string;
};

/** Used when `insurance_types` is missing or empty so apply forms still work. */
export const FALLBACK_INSURANCE_TYPES: InsuranceTypePublic[] = [
  { value: 'health_insurance', label: 'Health Insurance', image: 'health.svg' },
  { value: 'health_renewal', label: 'Health Renewal', image: 'health_renewal.svg' },
  { value: 'bike_insurance', label: 'Bike Insurance', image: 'bike.svg' },
  { value: 'vehicle_insurance', label: 'Vehicle Insurance', image: 'car.svg' },
  { value: 'pcv_insurance', label: 'PCV Insurance', image: 'pcv.svg' },
  { value: 'gcv_insurance', label: 'GCV Insurance', image: 'gcv.svg' },
  { value: 'travel_insurance', label: 'Travel Insurance', image: 'travel.svg' },
  { value: 'life_insurance', label: 'Life Insurance', image: 'life.svg' },
  { value: 'personal_accident_insurance', label: 'Personal Accident Insurance', image: 'pa.svg' },
  { value: 'miscd_insurance', label: 'MISC-D Insurance', image: 'miscd.svg' },
  { value: 'third_party_bike_insurance', label: 'Third Party Bike Insurance', image: 'third-party-bike-insurance.svg' },
  { value: 'third_party_pvt_vehicle_insurance', label: 'Third Party Pvt Vehicle Insurance', image: 'third-party-pvt-car-insurance.svg' },
  { value: 'third_party_pcv_insurance', label: 'Third Party PCV Insurance', image: 'third-party-pcv-insurance.svg' },
  { value: 'third_party_gcv_insurance', label: 'Third Party GCV Insurance', image: 'third-party-gcv-insurance.svg' },
  { value: 'third_party_miscd_insurance', label: 'Third Party MISC-D Insurance', image: 'third-party-miscd-insurance.svg' },
  { value: 'marine_insurance', label: 'Marine Insurance', image: 'home_marine_icon.svg' },
  { value: 'pet_insurance', label: 'Pet Insurance', image: 'pet-insurance.svg' },
  { value: 'cyber_insurance', label: 'Cyber Insurance', image: 'cyber-insurance.svg' },
];

export type VehicleCategoryPublic = {
  value: string;
  label: string;
  /** File name in `public/images/vehicle`, or a full path/URL. */
  image: string;
};

/** Used when `vehicle_categories` is missing so the vehicle loan form still works. */
export const FALLBACK_VEHICLE_CATEGORIES: VehicleCategoryPublic[] = [
  { value: 'new_car', label: 'New Car', image: 'car.webp' },
  { value: 'used_car', label: 'Used Car', image: 'used_car.webp' },
  { value: 'taxi', label: 'Taxi', image: 'taxi.webp' },
  { value: 'tractor', label: 'Tractor', image: 'tractor.webp' },
  { value: 'commercial_vehicle', label: 'Commercial Vehicle', image: 'commercial.webp' },
  { value: 'construction_equipment', label: 'Construction Equipment', image: 'construction.webp' },
];

export function slugToLeadCategory(slug: string): string {
  const s = slug.trim().toLowerCase();
  if (!s) return 'personal_loan';
  return s.replace(/-/g, '_');
}

export function isInsTypeSlug(value: string): boolean {
  return INS_TYPE_SLUG_PATTERN.test(value.trim().toLowerCase());
}
