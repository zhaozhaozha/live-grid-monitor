#!/usr/bin/env python3
"""JSX 结构校验：括号平衡 + JSX 标签平衡。

先构建「代码掩码」屏蔽字符串/注释/模板串，再用状态机解析标签，
避免在 `=>`、`{{ }}`、字符串内的尖括号上产生误判。
用法：python3 scripts/check-jsx.py <web目录>
"""
import pathlib
import sys

IDENT = set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._$')
VOID = {'br', 'hr', 'img', 'input', 'meta', 'link', 'source',
        'area', 'base', 'col', 'embed', 'track', 'wbr'}


def code_mask(s):
    """标记字符是否处于代码上下文（非字符串、非注释）。模板串的 ${} 视为代码。"""
    n = len(s)
    mask = [True] * n
    i = 0
    while i < n:
        if s.startswith('//', i):
            j = s.find('\n', i)
            j = n if j < 0 else j
            for k in range(i, j):
                mask[k] = False
            i = j
            continue
        if s.startswith('/*', i):
            j = s.find('*/', i + 2)
            j = n if j < 0 else j + 2
            for k in range(i, j):
                mask[k] = False
            i = j
            continue
        if s[i] in '"\'':
            q = s[i]
            i += 1
            while i < n:
                if s[i] == '\\':
                    mask[i] = False
                    i += 2
                    continue
                if s[i] == q:
                    mask[i] = False
                    i += 1
                    break
                mask[i] = False
                i += 1
            continue
        if s[i] == '`':
            i += 1
            while i < n:
                if s[i] == '\\':
                    mask[i] = False
                    i += 2
                    continue
                if s[i] == '`':
                    mask[i] = False
                    i += 1
                    break
                if s.startswith('${', i):
                    mask[i] = mask[i + 1] = False
                    depth = 1
                    i += 2
                    while i < n and depth:
                        if s[i] == '{':
                            depth += 1
                        elif s[i] == '}':
                            depth -= 1
                            if depth == 0:
                                mask[i] = False
                                i += 1
                                break
                        i += 1
                    continue
                mask[i] = False
                i += 1
            continue
        i += 1
    return mask


def check(path):
    s = pathlib.Path(path).read_text(encoding='utf-8')
    mask = code_mask(s)
    n = len(s)

    def line(k):
        return s[:k].count('\n') + 1

    errs = []

    # 1) 括号平衡
    stack = []
    pairs = {')': '(', ']': '[', '}': '{'}
    for i, c in enumerate(s):
        if not mask[i]:
            continue
        if c in '([{':
            stack.append((c, line(i)))
        elif c in ')]}':
            if not stack or stack[-1][0] != pairs[c]:
                errs.append(f"L{line(i)}: 括号不匹配 '{c}'")
            else:
                stack.pop()
    for ch, ln in stack:
        errs.append(f"L{ln}: 括号未闭合 '{ch}'")

    # 2) JSX 标签平衡
    tstack = []
    i = 0
    while i < n:
        if not mask[i] or s[i] != '<':
            i += 1
            continue
        j = i + 1
        closing = False
        if j < n and s[j] == '/':
            closing = True
            j += 1
        if j >= n or s[j] not in IDENT or s[j].isdigit():
            i += 1
            continue
        k = j
        while k < n and s[k] in IDENT:
            k += 1
        name = s[j:k]

        depth = 0
        p = k
        closed = False
        selfclose = False
        while p < n:
            if mask[p]:
                if s[p] == '{':
                    depth += 1
                elif s[p] == '}':
                    depth -= 1
                elif s[p] == '>' and depth == 0:
                    selfclose = s[p - 1] == '/' and mask[p - 1]
                    closed = True
                    break
            p += 1
        if not closed:
            errs.append(f"L{line(i)}: 标签 <{'/' if closing else ''}{name}> 未找到 '>'")
            i = k
            continue

        if closing:
            if not tstack or tstack[-1][0] != name:
                top = tstack[-1][0] if tstack else '空'
                errs.append(f"L{line(i)}: </{name}> 与栈顶 <{top}> 不匹配")
            else:
                tstack.pop()
        elif not selfclose and name.lower() not in VOID:
            tstack.append((name, line(i)))
        i = p + 1

    for name, ln in tstack:
        errs.append(f"L{ln}: 标签 <{name}> 未闭合")
    return errs


def main():
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
    files = sorted(set(list(root.rglob('*.jsx')) + list(root.rglob('*.js'))))
    allok = True
    for f in files:
        errs = check(f)
        if errs:
            allok = False
            print(f"❌ {f}")
            for e in errs[:10]:
                print("   ", e)
        else:
            print(f"✅ {f}")
    print("\n结论：", "全部通过" if allok else "存在结构问题")
    return 0 if allok else 1


if __name__ == '__main__':
    sys.exit(main())
