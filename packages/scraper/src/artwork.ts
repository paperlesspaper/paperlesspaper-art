export type Artwork = {
  id: string;
  source: "met" | "artic" | "svgrepo" | "wikimedia";
  sourceId: string;
  title: string;
  description?: string;
  artist?: string;
  date?: string;
  isPublicDomain: boolean;
  license: string;
  licenseUrl?: string;
  rights?: string;
  sourceUrl: string;
  collection?: {
    name: string;
    url: string;
  };
  author?: {
    name: string;
    url: string;
  };
  tags?: string[];
  image: {
    originalUrl: string;
    width?: number;
    height?: number;
    localOriginalPath?: string;
    localResizedPaths?: Record<string, string>;
  };
  search: {
    query: string;
    downloadedAt: string;
  };
};
