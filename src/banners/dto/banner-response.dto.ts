export class BannerResponseDto {
  id: string;
  imageUrl: string;
  title?: string;
  description?: string;
  category: string;
  displayOrder: number;
  actionUrl?: string;
  actionType?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
