package Frames;

import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import javax.imageio.ImageIO;

/** Renders the original Java bill / menu printouts to PNGs using a fake PrintJob (A4 @72dpi). */
public class PrintRef {
    static class FakeJob extends PrintJob {
        List<BufferedImage> pages = new ArrayList<BufferedImage>();
        public Graphics getGraphics() {
            BufferedImage img = new BufferedImage(595, 842, BufferedImage.TYPE_INT_RGB);
            Graphics2D g = img.createGraphics();
            g.setColor(Color.WHITE); g.fillRect(0, 0, 595, 842); g.setColor(Color.BLACK);
            g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
            pages.add(img);
            return g;
        }
        public Dimension getPageDimension() { return new Dimension(595, 842); }
        public int getPageResolution() { return 72; }
        public boolean lastPageFirst() { return false; }
        public void end() {}
    }

    // args: outprefix date file1 [file2...]
    public static void main(String[] a) throws Exception {
        FakeJob job = new FakeJob();
        String[] files = new String[a.length - 2];
        System.arraycopy(a, 2, files, 0, files.length);
        print p = new print(files, job, a[1]);
        p.print();
        for (int i = 0; i < job.pages.size(); i++) ImageIO.write(job.pages.get(i), "png", new File(a[0] + "-" + i + ".png"));
        System.out.println("pages=" + job.pages.size());
        System.exit(0);
    }
}
