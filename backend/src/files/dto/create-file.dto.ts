import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateFileDto {
  @IsString()
  @Matches(/^[^\n\r]*$/, { message: 'name must be a single line' })
  @MaxLength(180)
  name!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[^\n\r]*$/, { message: 'path must be a single line' })
  @MaxLength(500)
  path?: string;

  @IsOptional()
  @IsString()
  language?: string;
}
