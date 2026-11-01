import java.awt.*;
import java.awt.event.*;
import java.awt.image.BufferedImage;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.List;
import javax.imageio.ImageIO;
import javax.swing.*;
import javax.swing.table.*;
import javax.swing.text.JTextComponent;

/**
 * Test harness: launches a main class in-process, then serves line commands on a TCP port.
 * Commands (one per line, response terminated by a line "<<END>>"):
 *   dump                       - tree of all visible windows
 *   shot <path>                - screenshot
 *   click <text> [n]           - doClick on n-th visible button with text (in topmost window first)
 *   settext <n> <text...>      - set text of n-th text component in the active (last shown) window
 *   key <code> [ctrl] [alt] [shift] - robot key press (code = KeyEvent VK_ name without VK_)
 *   type <text>                - robot type ASCII text
 *   mouse <x> <y> [double]     - robot click at screen coords
 *   table <n> select <r1,r2..> - select rows in n-th table of active window
 *   table <n> cellclick <r> <c>- select row r col c and request focus
 *   table <n> edit <r> <c> <text> - setValueAt through the model
 *   combo <n> select <item>    - select item in n-th combo of active window
 *   tab <n> <title>            - select tab by title in n-th tabbed pane of active window
 *   check <n> <true|false>     - set n-th checkbox
 *   close                      - dispose the active window
 *   sleep <ms>
 */
public class Harness {
    static Robot robot;

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]);
        final String mainClass = args[1];
        System.setSecurityManager(new SecurityManager() {
            public void checkPermission(java.security.Permission perm) {}
            public void checkExit(int status) {
                boolean real = false;
                for (StackTraceElement e : new Throwable().getStackTrace()) if (e.getClassName().equals("java.lang.Runtime") && e.getMethodName().equals("exit")) real = true;
                if (real) new Throwable("System.exit(" + status + ") called").printStackTrace();
            }
        });
        robot = new Robot();
        robot.setAutoDelay(20);
        final ServerSocket ss = new ServerSocket(port, 5, InetAddress.getByName("127.0.0.1"));
        Class.forName(mainClass).getMethod("main", String[].class).invoke(null, (Object) new String[0]);
        while (true) {
            Socket s = ss.accept();
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), "UTF-8"));
            PrintWriter out = new PrintWriter(new OutputStreamWriter(s.getOutputStream(), "UTF-8"), true);
            String line;
            while ((line = in.readLine()) != null) {
                String res;
                try {
                    res = handle(line);
                } catch (Throwable t) {
                    StringWriter sw = new StringWriter();
                    t.printStackTrace(new PrintWriter(sw));
                    res = "ERROR " + sw;
                }
                out.println(res);
                out.println("<<END>>");
            }
            s.close();
        }
    }

    static List<Window> windows() {
        List<Window> l = new ArrayList<Window>();
        for (Window w : Window.getWindows()) if (w.isShowing()) l.add(w);
        return l;
    }

    static Window active() {
        Window f = KeyboardFocusManager.getCurrentKeyboardFocusManager().getActiveWindow();
        if (f != null && f.isShowing()) return f;
        List<Window> l = windows();
        return l.isEmpty() ? null : l.get(l.size() - 1);
    }

    static <T> List<T> find(Container c, Class<T> cls, List<T> acc) {
        for (Component k : c.getComponents()) {
            if (!k.isShowing()) continue;
            if (cls.isInstance(k)) acc.add(cls.cast(k));
            if (k instanceof Container) find((Container) k, cls, acc);
        }
        return acc;
    }

    static String onEdt(final java.util.concurrent.Callable<String> c) throws Exception {
        final String[] r = new String[1];
        final Throwable[] e = new Throwable[1];
        SwingUtilities.invokeAndWait(new Runnable() {
            public void run() {
                try { r[0] = c.call(); } catch (Throwable t) { e[0] = t; }
            }
        });
        if (e[0] != null) throw new RuntimeException(e[0]);
        return r[0];
    }

    static String handle(String line) throws Exception {
        final String[] p = line.split(" ", -1);
        final String cmd = p[0];
        if (cmd.equals("sleep")) { Thread.sleep(Long.parseLong(p[1])); return "ok"; }
        if (cmd.equals("shot")) {
            Rectangle r = new Rectangle(java.awt.Toolkit.getDefaultToolkit().getScreenSize());
            BufferedImage img = robot.createScreenCapture(r);
            ImageIO.write(img, "png", new File(p[1]));
            return "ok";
        }
        if (cmd.equals("key")) {
            int code = KeyEvent.class.getField("VK_" + p[1]).getInt(null);
            List<String> mods = Arrays.asList(p).subList(2, p.length);
            if (mods.contains("ctrl")) robot.keyPress(KeyEvent.VK_CONTROL);
            if (mods.contains("alt")) robot.keyPress(KeyEvent.VK_ALT);
            if (mods.contains("shift")) robot.keyPress(KeyEvent.VK_SHIFT);
            robot.keyPress(code); robot.keyRelease(code);
            if (mods.contains("shift")) robot.keyRelease(KeyEvent.VK_SHIFT);
            if (mods.contains("alt")) robot.keyRelease(KeyEvent.VK_ALT);
            if (mods.contains("ctrl")) robot.keyRelease(KeyEvent.VK_CONTROL);
            robot.waitForIdle();
            return "ok";
        }
        if (cmd.equals("type")) {
            String t = line.substring(5);
            for (char ch : t.toCharArray()) {
                boolean shift = Character.isUpperCase(ch);
                int code = KeyEvent.getExtendedKeyCodeForChar(ch);
                if (ch == ' ') code = KeyEvent.VK_SPACE;
                if (shift) robot.keyPress(KeyEvent.VK_SHIFT);
                robot.keyPress(code); robot.keyRelease(code);
                if (shift) robot.keyRelease(KeyEvent.VK_SHIFT);
            }
            robot.waitForIdle();
            return "ok";
        }
        if (cmd.equals("mouse")) {
            robot.mouseMove(Integer.parseInt(p[1]), Integer.parseInt(p[2]));
            int n = p.length > 3 ? 2 : 1;
            for (int i = 0; i < n; i++) {
                robot.mousePress(InputEvent.BUTTON1_MASK); robot.mouseRelease(InputEvent.BUTTON1_MASK);
            }
            robot.waitForIdle();
            return "ok";
        }
        return onEdt(new java.util.concurrent.Callable<String>() {
            public String call() throws Exception {
                Window w = active();
                if (cmd.equals("dump")) {
                    StringBuilder sb = new StringBuilder();
                    for (Window win : windows()) {
                        sb.append("WINDOW ").append(win.getClass().getName()).append(" title=")
                          .append(win instanceof Frame ? ((Frame) win).getTitle() : "")
                          .append(win == w ? " [ACTIVE]" : "").append(" bounds=").append(win.getBounds()).append('\n');
                        dumpTree(win, sb, "  ");
                    }
                    return sb.toString();
                }
                if (cmd.equals("windows")) {
                    StringBuilder sb = new StringBuilder();
                    for (Window win : windows()) sb.append(win.getClass().getName()).append(" | ").append(win instanceof Frame ? ((Frame) win).getTitle() : "").append(win == w ? " [ACTIVE]" : "").append('\n');
                    return sb.toString();
                }
                if (cmd.equals("focus")) {
                    for (Window win : windows()) if (win.getClass().getName().endsWith(p[1])) { win.toFront(); win.requestFocus(); return "ok"; }
                    return "no window";
                }
                if (cmd.equals("click")) {
                    String text = p[1].replace('_', ' ');
                    int n = p.length > 2 ? Integer.parseInt(p[2]) : 0;
                    List<Window> ws = windows();
                    Collections.reverse(ws);
                    if (w != null) { ws.remove(w); ws.add(0, w); }
                    for (Window win : ws) {
                        int k = 0;
                        for (AbstractButton b : find(win, AbstractButton.class, new ArrayList<AbstractButton>())) {
                            if (text.equals(b.getText())) {
                                if (k++ == n) { b.doClick(); return "clicked in " + win.getClass().getName(); }
                            }
                        }
                    }
                    return "button not found";
                }
                if (cmd.equals("locate")) {
                    // screen centre of the n-th showing button with this text (for mouse-listener buttons)
                    String text = p[1].replace('_', ' ');
                    for (Window win : windows())
                        for (JComponent b : find(win, JComponent.class, new ArrayList<JComponent>())) {
                            String t = b instanceof AbstractButton ? ((AbstractButton) b).getText() : b instanceof JLabel ? ((JLabel) b).getText() : null;
                            if (text.equals(t)) {
                                Point pt = b.getLocationOnScreen();
                                return (pt.x + b.getWidth() / 2) + " " + (pt.y + b.getHeight() / 2);
                            }
                        }
                    return "button not found";
                }
                if (w == null) return "no active window";
                if (cmd.equals("close")) { w.dispose(); return "ok"; }
                if (cmd.equals("settext")) {
                    List<JTextComponent> l = find(w, JTextComponent.class, new ArrayList<JTextComponent>());
                    JTextComponent t = l.get(Integer.parseInt(p[1]));
                    t.setText(line.substring(line.indexOf(' ', 8) + 1));
                    // fire key released so listeners that validate on keyReleased run
                    for (KeyListener kl : t.getKeyListeners())
                        kl.keyReleased(new KeyEvent(t, KeyEvent.KEY_RELEASED, System.currentTimeMillis(), 0, KeyEvent.VK_A, 'a'));
                    return "ok";
                }
                if (cmd.equals("check")) {
                    List<JCheckBox> l = find(w, JCheckBox.class, new ArrayList<JCheckBox>());
                    JCheckBox c = l.get(Integer.parseInt(p[1]));
                    if (c.isSelected() != Boolean.parseBoolean(p[2])) c.doClick();
                    return "ok";
                }
                if (cmd.equals("combo")) {
                    List<JComboBox> l = find(w, JComboBox.class, new ArrayList<JComboBox>());
                    l.get(Integer.parseInt(p[1])).setSelectedItem(line.substring(line.indexOf("select ") + 7));
                    return "ok";
                }
                if (cmd.equals("tab")) {
                    List<JTabbedPane> l = find(w, JTabbedPane.class, new ArrayList<JTabbedPane>());
                    JTabbedPane tp = l.get(Integer.parseInt(p[1]));
                    String title = line.substring(line.indexOf(' ', 4) + 1);
                    for (int i = 0; i < tp.getTabCount(); i++) if (tp.getTitleAt(i).equals(title)) { tp.setSelectedIndex(i); return "ok"; }
                    return "tab not found";
                }
                if (cmd.equals("table")) {
                    List<JTable> l = find(w, JTable.class, new ArrayList<JTable>());
                    JTable t = l.get(Integer.parseInt(p[1]));
                    if (p[2].equals("select")) {
                        t.clearSelection();
                        for (String r : p[3].split(",")) { int ri = Integer.parseInt(r); t.addRowSelectionInterval(ri, ri); }
                        if (t.getColumnCount() > 0) t.setColumnSelectionInterval(0, t.getColumnCount() - 1);
                        t.requestFocusInWindow();
                        return "ok";
                    }
                    if (p[2].equals("cellclick")) {
                        int r = Integer.parseInt(p[3]), c = Integer.parseInt(p[4]);
                        t.changeSelection(r, c, false, false);
                        t.requestFocusInWindow();
                        return "ok";
                    }
                    if (p[2].equals("edit")) {
                        int r = Integer.parseInt(p[3]), c = Integer.parseInt(p[4]);
                        String v = line.substring(line.indexOf(p[4], line.indexOf(" edit ") + 6 + p[3].length()) + p[4].length() + 1);
                        t.getModel().setValueAt(v, r, c);
                        return "ok";
                    }
                }
                return "unknown command";
            }
        });
    }

    static void dumpTree(Container c, StringBuilder sb, String ind) {
        for (Component k : c.getComponents()) {
            if (!k.isShowing()) continue;
            String extra = null;
            if (k instanceof JLabel) extra = "label '" + ((JLabel) k).getText() + "'";
            else if (k instanceof AbstractButton) extra = k.getClass().getSimpleName() + " '" + ((AbstractButton) k).getText() + "'" + (k.isEnabled() ? "" : " (disabled)") + ((k instanceof JToggleButton && ((AbstractButton) k).isSelected()) ? " [x]" : "");
            else if (k instanceof JTextComponent) extra = k.getClass().getSimpleName() + " text='" + ((JTextComponent) k).getText() + "'" + (k.isEnabled() ? "" : " (disabled)");
            else if (k instanceof JComboBox) {
                JComboBox cb = (JComboBox) k;
                StringBuilder items = new StringBuilder();
                for (int i = 0; i < cb.getItemCount() && i < 30; i++) items.append(cb.getItemAt(i)).append('|');
                extra = "combo selected=" + cb.getSelectedItem() + " items=" + items;
            } else if (k instanceof JTabbedPane) {
                JTabbedPane tp = (JTabbedPane) k;
                StringBuilder tabs = new StringBuilder();
                for (int i = 0; i < tp.getTabCount(); i++) tabs.append(tp.getTitleAt(i)).append(i == tp.getSelectedIndex() ? "*" : "").append('|');
                extra = "tabs " + tabs;
            } else if (k instanceof JTable) {
                JTable t = (JTable) k;
                StringBuilder tb = new StringBuilder("table cols=");
                for (int i = 0; i < t.getColumnCount(); i++) tb.append(t.getColumnModel().getColumn(i).getHeaderValue()).append('|');
                tb.append(" selected=").append(Arrays.toString(t.getSelectedRows()));
                for (int r = 0; r < t.getRowCount(); r++) {
                    boolean any = false;
                    StringBuilder row = new StringBuilder();
                    for (int col = 0; col < t.getColumnCount(); col++) {
                        Object v = t.getValueAt(r, col);
                        if (v != null && !"".equals(v.toString()) && !"--".equals(v.toString())) any = true;
                        row.append(v).append(" | ");
                    }
                    if (any) tb.append("\n").append(ind).append("   r").append(r).append(": ").append(row);
                }
                extra = tb.toString();
            }
            if (extra != null) sb.append(ind).append(extra).append('\n');
            if (k instanceof Container) dumpTree((Container) k, sb, ind + (extra != null ? "  " : ""));
        }
    }
}
