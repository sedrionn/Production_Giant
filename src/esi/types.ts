/** Raw ESI response shapes we use (subset of fields). */

export interface EsiMarketPrice {
  type_id: number;
  adjusted_price?: number;
  average_price?: number;
}

export interface EsiIndustrySystem {
  solar_system_id: number;
  cost_indices: { activity: string; cost_index: number }[];
}

export interface EsiMarketOrder {
  order_id: number;
  type_id: number;
  location_id: number;
  price: number;
  volume_remain: number;
  is_buy_order: boolean;
  range?: string;
}

export interface EsiMarketHistoryDay {
  date: string; // YYYY-MM-DD
  average: number;
  highest: number;
  lowest: number;
  order_count: number;
  volume: number;
}

export const REGION_THE_FORGE = 10000002;
export const STATION_JITA_4_4 = 60003760;
export const SYSTEM_JITA = 30000142;
