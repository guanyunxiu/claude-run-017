import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { FileVersionService } from './file-version.service';

@UseGuards(JwtAuthGuard)
@Controller('files/:fileId/versions')
export class FileVersionController {
  constructor(private readonly versions: FileVersionService) {}

  /** GET /api/files/:fileId/versions */
  @Get()
  list(
    @Param('fileId') fileId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.versions.listVersions(fileId, user.id);
  }

  /** GET /api/files/:fileId/versions/:version/preview */
  @Get(':version/preview')
  preview(
    @Param('fileId') fileId: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentUser() user: { id: string },
  ) {
    return this.versions.previewVersion(fileId, version, user.id);
  }

  /** POST /api/files/:fileId/versions/:version/restore (owner only) */
  @Post(':version/restore')
  restore(
    @Param('fileId') fileId: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentUser() user: { id: string },
  ) {
    return this.versions.restoreVersion(fileId, version, user.id);
  }
}
