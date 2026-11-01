#!/bin/bash
# Compiles the original Java program (sibling checkout ../Utility-Soft) and the
# test harness into compat/.build. Needs a JDK 8 (JAVA_HOME or ~/tools/jdk8).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${JAVA_SRC:-$HERE/../../Utility-Soft}
JDK=${JAVA_HOME:-$HOME/tools/jdk8}
OUT=$HERE/.build
rm -rf "$OUT" && mkdir -p "$OUT/classes/Printing"
CP=$(ls "$SRC"/lib/*.jar | tr '\n' ':')
find "$SRC/src" -name '*.java' > "$OUT/srcs.txt"
"$JDK/bin/javac" -nowarn -encoding UTF-8 -cp "$CP" -d "$OUT/classes" @"$OUT/srcs.txt" 2>&1 | grep -v '^Note:' || true
cp -r "$SRC/src/Images" "$OUT/classes/"
cp "$SRC"/src/Printing/*.png "$SRC"/src/Printing/*.gif "$OUT/classes/Printing/"
"$JDK/bin/javac" -nowarn -cp "$OUT/classes:$CP" -d "$OUT/classes" "$HERE/Harness.java" "$HERE/Frames/PrintRef.java" 2>&1 | grep -v '^Note:' || true
echo "built $(find "$OUT/classes" -name '*.class' | wc -l) classes"
