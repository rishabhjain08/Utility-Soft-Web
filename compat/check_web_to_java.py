"""Opens data written by the web app with the original Java program and checks what it shows.

    python3 compat/check_web_to_java.py [DATA REPAIRED]

DATA defaults to .tmp/compat-export (built in the web format and exported by
e2e/compat-build.spec.ts); REPAIRED to .tmp/compat-repair-export (e2e/compat-repair.spec.ts)."""
import shutil
import subprocess
import sys
from pathlib import Path

from javaapp import HERE, JDK, JAVA_SRC, DISPLAY, JavaApp

SRC = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else HERE.parent / '.tmp' / 'compat-export'
WORK = HERE.parent / '.tmp' / 'compat-web-java'
failures = []


def check(what, got, want):
    ok = got == want
    print(('PASS ' if ok else 'FAIL ') + what)
    if not ok:
        print('   want:', want)
        print('   got: ', got)
        failures.append(what)


def client_rows(app):
    t = app.tables('Frames.billing')[0]
    return [' | '.join(r[:3]).replace('null', '').strip() for r in t['rows']]


def bill_rows(app):
    t = app.tables('Frames.bills')[0]
    return t['cols'], [r[:6] for r in t['rows']]


def main():
    shutil.rmtree(WORK, ignore_errors=True)
    shutil.copytree(SRC, WORK)
    with JavaApp(WORK, 7101) as app:
        app.login('puja')
        check('main window opens', app.windows()[-1], 'Frames.billing')
        check('06-07 clients', client_rows(app), ['1 | AMIT KUMAR | 101-102', '2 | PREM |', '2A | PRIYA |', '3 | RISHABH |'])
        app.cmd('combo 0 select 07-08')
        app.wait(800)
        check('07-08 clients', client_rows(app), ['1 | AMIT KUMAR | 101-102', '2 | PREM |', '2A | PRIYA |', '3 | RISHABH |'])

        # Open RISHABH in 07-08.
        app.cmd('table 0 select 3')
        app.click('OK')
        app.wait(1500)
        w = app.window('Frames.bills')
        check('bill types incl. the web-added GST tab', 'tabs Audit*|Vat|Tax|Others|GST|' in w, True)
        check('bill tab PREM CHAND', 'tabs PREM CHAND*|' in w, True)
        cols, rows = bill_rows(app)
        check('bill header totals', cols, ['S.No.', 'Field', 'Total = 16,625/-  Rs.', '15,520/-  Rs. for 06-07', '0/-  Rs. for 05-06', '0/-  Rs. for 04-05'])
        check('bill rows with last year alongside', rows, [
            ['1', 'pooja', '25', '20', '--', '--'],
            ['2', 'Fee for Tax Audit for the Assessment Year 07-08', '16000', '15000', '--', '--'],
            ['', 'New Name', '', '--', '--', '--'],
            ['3', 'SMT. KAMLA', '', '--', '--', '--'],
            ['4', 'Expenses', '600', '500', '--', '--'],
        ])
        lock = (WORK / 'data' / 'activelocation.txt').read_text()
        check('Java locks the client in activelocation.txt', lock.strip(), '07-08,RISHABH')
        # The same bill in 06-07 via the editor's year box.
        app.show_options()
        app.cmd('combo 0 select 06-07')
        app.wait(1200)
        app.cmd('tab 0 Audit')
        cols, rows = bill_rows(app)
        check('06-07 version of the same bill', rows, [
            ['1', 'pooja', '20', '--', '--', '--'], ['2', 'Fee for Tax Audit for the Assessment Year 06-07', '15000', '--', '--', '--'],
            ['', 'New Name', '', '--', '--', '--'], ['3', 'SMT. KAMLA', '', '--', '--', '--'], ['4', 'Expenses', '500', '--', '--', '--']])
        app.bills_button('Done')
        app.wait(800)
        check('Java releases the lock', (WORK / 'data' / 'activelocation.txt').read_text().strip(), '')

        app.cmd('combo 0 select 06-07')
        app.wait(800)
        app.cmd('table 0 select 0')
        app.click('OK')
        app.wait(1500)
        app.cmd('tab 0 Tax')
        app.wait(300)
        cols, rows = bill_rows(app)
        check('description with a comma', rows, [['1', 'Fee for IT Return for the Assessment Year 06-07, with schedules', '2500', '--', '--', '--']])
        app.bills_button('Done')
        app.wait(1000)
        # Java asks to update AMIT KUMAR to 07-08? It exists already, so no question.
        check('no update question for a client present next year', 'Frames.askforupdate' in app.windows(), False)

        # The drop-down list editor shows the web-saved GST list.
        app.click('Utility')
        app.wait(800)
        app.click('Edit Drop Down List')
        app.wait(1200)
        app.cmd('tab 0 GST')
        t = [x for x in app.tables('Frames.DropDownList') if x['rows']]
        gst = [r[0] for r in t[0]['rows']] if t else []
        check('GST drop-down list', gst, ['GST return for ##'])
        app.click('DONE')
        app.wait(800)

    # Java's bill printout of the web-written bill, rendered to images for review.
    out = HERE.parent / '.tmp' / 'java-print-web-bill'
    cp = ':'.join([str(HERE / '.build' / 'classes')] + [str(p) for p in sorted((JAVA_SRC / 'lib').glob('*.jar'))])
    r = subprocess.run([str(JDK / 'bin' / 'java'), '-cp', cp, 'Frames.PrintRef', str(out), '01.11.2026',
                        str(WORK / 'data/bills/07-08/RISHABH/Audit/PREM CHAND.txt')],
                       cwd=WORK, env={'DISPLAY': DISPLAY, 'PATH': '/usr/bin:/bin'}, capture_output=True, text=True)
    check('Java prints the web-written bill', r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr[-300:], 'pages=2')

    # Java-written data that the Java program could not open, after the web app opened it.
    repair_src = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else HERE.parent / '.tmp' / 'compat-repair-export'
    repair = HERE.parent / '.tmp' / 'compat-repair-java'
    if repair_src.exists():
        shutil.rmtree(repair, ignore_errors=True)
        shutil.copytree(repair_src, repair)
        with JavaApp(repair, 7106) as app:
            app.login('puja')
            app.cmd('combo 0 select 06-07')
            app.wait(800)
            app.cmd('table 0 select 1')
            app.click('OK')
            app.wait(1500)
            check('Java opens the repaired bill', 'Frames.bills' in app.windows(), True)
            cols, rows = bill_rows(app)
            check('repaired bill rows', rows, [['1', 'SHRI PREM CHAND', '', '--', '--', '--'], ['2', 'Fee', '200', '100', '--', '--']])
            app.bills_button('Done')
            app.wait(800)
            check('Java releases the lock', (repair / 'data' / 'activelocation.txt').read_text().strip(), '')
    else:
        print('SKIP repaired-bill check (run e2e/compat-repair.spec.ts first)')

    print()
    print('ALL PASSED' if not failures else f'{len(failures)} FAILED: {failures}')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
