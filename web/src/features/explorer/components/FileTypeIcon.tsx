import {
  AudioOutlined,
  CodeOutlined,
  FileImageOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FileZipOutlined,
  FolderFilled,
  VideoCameraOutlined,
} from '@ant-design/icons';
import type { ComponentType } from 'react';
import { StorageObject } from '../../../lib/api';
import { FileKind, getFileKind } from '../utils/objects';

const KIND_STYLE: Record<
  FileKind,
  { Icon: ComponentType<{ className?: string }>; color: string }
> = {
  folder: { Icon: FolderFilled, color: 'text-amber-500' },
  image: { Icon: FileImageOutlined, color: 'text-pink-500' },
  video: { Icon: VideoCameraOutlined, color: 'text-purple-500' },
  audio: { Icon: AudioOutlined, color: 'text-cyan-600' },
  pdf: { Icon: FilePdfOutlined, color: 'text-rose-500' },
  archive: { Icon: FileZipOutlined, color: 'text-orange-500' },
  code: { Icon: CodeOutlined, color: 'text-blue-600' },
  file: { Icon: FileTextOutlined, color: 'text-slate-400' },
};

interface FileTypeIconProps {
  object: Pick<StorageObject, 'isFolder' | 'contentType'>;
  sizeClass?: string;
}

/** 按文件类型渲染对应颜色的图标 */
export function FileTypeIcon({ object, sizeClass = 'text-lg' }: FileTypeIconProps) {
  const { Icon, color } = KIND_STYLE[getFileKind(object)];
  return <Icon className={`${sizeClass} ${color}`} />;
}
