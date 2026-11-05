"""Prepare a Git-ignored WeChat workspace without changing public source files."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--appid', default=os.environ.get('WECHAT_APPID'))
    args = parser.parse_args()
    appid = args.appid or input('WeChat AppID: ').strip()
    if not re.fullmatch(r'wx[0-9a-fA-F]{16}', appid):
        parser.error('Expected a WeChat AppID beginning with wx and 16 hexadecimal characters')
    root = Path(__file__).resolve().parents[1]
    target = root / '.local' / 'wechat'
    shutil.copytree(root / 'miniprogram', target, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('tests', 'project.private.config.json', 'project.local.config.json'))
    config_path = target / 'project.config.json'
    config = json.loads(config_path.read_text(encoding='utf-8'))
    config['appid'] = appid
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('Import .local/wechat in WeChat DevTools. This workspace is ignored by Git.')


if __name__ == '__main__':
    main()
