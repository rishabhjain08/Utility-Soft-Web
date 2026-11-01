"""Creates data with the original Java program (through its UI) in .tmp/compat-java,
for e2e/compat-read.spec.ts to open with the web app."""
import shutil
import sys

from javaapp import HERE, JavaApp

SRC = HERE.parent / 'tests' / 'fixtures' / 'java-sample'
OUT = HERE.parent / '.tmp' / 'compat-java'


def expect(what, cond):
    print(('ok   ' if cond else 'FAIL ') + what)
    if not cond:
        sys.exit(1)


def clients(app):
    t = app.tables('Frames.billing')[0]
    return [' | '.join(r[:3]).replace('null', '').strip() for r in t['rows']]


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    shutil.copytree(SRC, OUT)
    with JavaApp(OUT, 7104) as app:
        app.login()
        # Add New (normal) and a late entry.
        app.click('Add New')
        app.wait(800)
        app.cmd('settext 0 mohan')
        app.click('OK')
        app.wait(1000)
        app.click('Add New')
        app.wait(800)
        app.cmd('settext 0 prakash')
        app.cmd('check 0 true')
        app.click('OK')
        app.wait(1000)
        expect('Java serials', clients(app) == ['1 | MOHAN |', '1A | PRAKASH |', '2 | PREM |', '3 | RISHABH |'])

        # Modify RISHABH's bill no.
        app.cmd('table 0 select 3')
        app.click('Modify')
        app.wait(800)
        app.cmd('settext 1 55')
        app.click('OK')
        app.wait(1000)
        expect('Java bill no', clients(app)[-1] == '3 | RISHABH | 55')

        # New bill for MOHAN in Audit, with a "New Name" separator.
        app.cmd('table 0 select 0')
        app.click('OK')
        app.wait(1500)
        app.bills_button('New Bill')
        app.wait(800)
        app.cmd('settext 0 gopal')
        app.click('OK')
        app.wait(1200)
        rows = [
            (0, 1, 'Fee for VAT Audit for the Assessment Year 06-07'), (0, 2, '700'),
            (1, 1, 'Expenses'), (1, 2, '50'),
        ]
        for r, c, v in rows:
            app.cmd(f'table 0 edit {r} {c} {v}')
            app.wait(300)
        app.cmd('table 0 cellclick 2 1')
        app.bills_button('New Name')
        app.wait(500)
        for r, c, v in [(3, 1, 'Fee for IT Return for the Assessment Year 06-07'), (3, 2, '1200')]:
            app.cmd(f'table 0 edit {r} {c} {v}')
            app.wait(300)
        app.bills_button('Done')
        app.wait(1000)

        # Utility: Add Next Year, then Copy Data 06-07 -> 07-08 (all names).
        app.click('Utility')
        app.wait(800)
        app.mouse_click('Add Next Year')
        app.wait(1500)
        app.focus = app.cmd('focus utility')
        app.click('Copy Data')
        app.wait(1000)
        app.cmd('combo 0 select 06-07')
        app.cmd('combo 1 select 07-08')
        app.click('OK')
        app.wait(1500)
        app.click('OK')  # "The following names are being copied" -> all
        app.wait(2500)
        print('java windows:', app.windows())
    print('Java data written to', OUT)


if __name__ == '__main__':
    main()
