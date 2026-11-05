/**
 * 备份文件格式的共享定义。
 * 单独放一个模块，避免 restore 导入 backup 时触发 backup 的顶层执行逻辑。
 */

export interface BackupAsset {
  storageKey: string;
  size: number;
  sha256: string;
}

/** 备份 JSON 旁边放同名 .assets 目录，避免把二进制塞进 JSON 撑大内存。 */
export function assetsDirOf(backupFile: string): string {
  return `${backupFile}.assets`;
}