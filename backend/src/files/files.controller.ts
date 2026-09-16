import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt-user';
import { FilesService } from './files.service';
import { CreateFileDto } from './dto/create-file.dto';
import { UpdateFileDto } from './dto/update-file.dto';

@UseGuards(JwtAuthGuard)
@Controller()
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get('projects/:projectId/files')
  list(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.files.list(projectId, user.id);
  }

  @Post('projects/:projectId/files')
  create(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateFileDto,
  ) {
    return this.files.create(projectId, user.id, dto);
  }

  @Get('files/:fileId')
  get(@Param('fileId') fileId: string, @CurrentUser() user: AuthUser) {
    return this.files.get(fileId, user.id);
  }

  @Patch('files/:fileId')
  rename(
    @Param('fileId') fileId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateFileDto,
  ) {
    return this.files.rename(fileId, user.id, dto);
  }

  @Delete('files/:fileId')
  remove(@Param('fileId') fileId: string, @CurrentUser() user: AuthUser) {
    return this.files.remove(fileId, user.id);
  }

  @Get('files/:fileId/content')
  content(@Param('fileId') fileId: string, @CurrentUser() user: AuthUser) {
    return this.files.readContent(fileId, user.id);
  }
}
