import {
  BadGatewayException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface ImgbbUploadResponse {
  data?: {
    url?: string;
  };
  success?: boolean;
  status?: number;
}

@Injectable()
export class ImgbbService {
  private readonly uploadUrl = 'https://api.imgbb.com/1/upload';

  constructor(
    private readonly configService: ConfigService,
  ) {}

  async uploadImage(
    imageBuffer: Buffer,
  ): Promise<string> {
    const apiKey =
      this.configService.get<string>('IMGBB_API_KEY');

    if (!apiKey) {
      throw new BadGatewayException(
        'ImgBB API key is not configured',
      );
    }

    const formData = new FormData();

    formData.append(
      'image',
      imageBuffer.toString('base64'),
    );

    try {
      const response = await fetch(
        `${this.uploadUrl}?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          body: formData,
        },
      );

      const result =
        (await response.json()) as ImgbbUploadResponse;

      if (
        !response.ok ||
        !result.success ||
        !result.data?.url
      ) {
        throw new BadGatewayException(
          'ImgBB image upload failed',
        );
      }

      return result.data.url;
    } catch (error: unknown) {
      if (error instanceof BadGatewayException) {
        throw error;
      }

      throw new BadGatewayException(
        'Unable to upload image to ImgBB',
      );
    }
  }
}